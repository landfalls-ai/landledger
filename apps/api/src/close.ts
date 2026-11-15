/**
 * The close (wave 4, spec 012). A month moves open → closing → locked through a ten-step checklist whose gates
 * Landledger computes, never ticked by hand: usage ingested, reconciled, unallocated under its limit, no dev rows, no
 * open anomalies, no outstanding revokes, the accrual accepted (which freezes the snapshot), the variance notes
 * accepted, the Datarails upload, and the lock. A red step can be explained with a note (audited), never step 4 or 10.
 * The lock takes two people, a controller and the CFO: the second signature locks the month, writes the lock's audit
 * entry and anchors it outside the database at once. A locked month reopens only by a `period_reopen` request the CFO
 * approves; its ledger stays closed to inserts (corrections post to the open month) and two people lock it again.
 */
import { UNALLOCATED } from '@landledger/allocation';
import {
  type CloseStepKey,
  type CloseStepView,
  type CloseView,
  EXPLAINABLE_STEPS,
  type LockResult,
  type LockSignoff,
  type PeriodLockedData,
} from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AccessReviews } from './access-review.js';
import { nextMonth } from './accruals.js';
import type { Accruals } from './accruals.js';
import { anchorAudit } from './anchors.js';
import type { Anomalies } from './anomalies.js';
import type { AuditLog } from './audit.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import type { IngestLog } from './ingest/runner.js';
import type { Invoices } from './invoices.js';
import type { Periods } from './ledger.js';
import { monthLabel, type Notes } from './notes.js';
import { actorOf, type Principal } from './principal.js';
import type { Requests } from './requests.js';
import { DEV_FIXTURE } from './read-rule.js';
import type { Snapshots } from './snapshot.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;

export const STEP_TITLES: Record<CloseStepKey, string> = {
  usage_ingested: 'Usage ingested to the last day',
  reconciled: 'Reconciled within tolerance',
  unallocated: 'Unallocated under its limit',
  no_dev_rows: 'No dev-fixture or dev-anomaly rows',
  no_open_anomalies: 'No open anomalies',
  no_outstanding_revokes: 'No outstanding access-review revokes',
  accrual_accepted: 'Accrual accepted',
  notes_accepted: 'Variance notes accepted',
  datarails_uploaded: 'Datarails upload done',
  locked: 'Period locked',
};
export const STEP_ORDER = Object.keys(STEP_TITLES) as CloseStepKey[];

/** A reconciliation row needs nothing: matched, or nothing on one side to compare. */
export function rowOk(r: { status: string; estimated: string; invoiced: string; lateEstimates?: number }): boolean {
  if (r.lateEstimates) return false;
  if (r.status === 'matched') return true;
  if (r.status === 'not_invoiced') return Money.parse(r.estimated, USD).posted().isZero();
  if (r.status === 'no_estimate') return Money.parse(r.invoiced, USD).posted().isZero();
  return false;
}

type Gate = Pick<CloseStepView, 'summary' | 'problems' | 'rows'> & {
  ok: boolean;
  by?: string | null;
  at?: string | null;
};
type ExplRow = {
  id: string;
  step: CloseStepKey;
  row_key: string | null;
  note: string;
  email: string | null;
  name: string;
  explained_at: Date;
};
type LockRow = {
  month: Date;
  round: number;
  locked_at: Date;
  signoffs: LockSignoff[];
  gates: CloseStepView[];
  snapshot_id: string | null;
  audit_seq: string;
  audit_hash: string;
  snapshot_sha: string | null;
};

export class Close {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly periods: Periods,
    private readonly invoices: Invoices,
    private readonly anomalies: Anomalies,
    private readonly accessReviews: AccessReviews,
    private readonly snapshots: Snapshots,
    private readonly accruals: Accruals,
    private readonly notes: Notes,
    private readonly requests: Requests,
    private readonly config: { consoleUrl: string; unallocatedPct: string },
    private readonly log: IngestLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ended(month: string) {
    return this.now().getTime() >= Date.parse(`${nextMonth(month)}-01T00:00:00Z`);
  }

  // The period's state ------------------------------------------------------------------------------------------------

  /** open, closing, locked; the round (reopens so far); and whether a locked month is reopened, waiting to relock. */
  async period(
    month: string,
    tx: Tx = this.sql,
  ): Promise<{ status: 'open' | 'closing' | 'locked'; round: number; reopened: boolean }> {
    const first = `${month}-01`;
    const [r] = (await tx`
      SELECT (SELECT status FROM periods WHERE month = ${first}) AS status,
             (SELECT count(*)::int FROM period_reopens WHERE month = ${first}) AS reopens,
             (SELECT count(*)::int FROM close_locks WHERE month = ${first}) AS locks`) as unknown as [
      { status: string | null; reopens: number; locks: number },
    ];
    const status = (r.status ?? 'open') as 'open' | 'closing' | 'locked';
    return { status, round: r.reopens, reopened: status === 'locked' && r.reopens > 0 && r.locks <= r.reopens };
  }

  // Gates 1–6 -------------------------------------------------------------------------------------------------------

  private async gate1(month: string): Promise<Gate> {
    const problems = await this.periods.lockProblems(month);
    return {
      ok: !problems.length,
      summary: problems.length
        ? `${problems.length} problem(s)`
        : 'Every source is complete to the last day; every record is allocated',
      problems,
    };
  }

  private async gate2(month: string, explained: Set<string>): Promise<Gate> {
    const r = await this.invoices.reconciliation(month);
    const rows = r.rows
      .filter((x) => !x.devFixture)
      .map((x) => {
        const key = `${x.provider}|${x.model}`;
        return {
          key,
          provider: x.provider,
          model: x.model,
          status: x.status,
          estimated: x.estimated,
          invoiced: x.invoiced,
          variancePct: x.variancePct,
          ok: rowOk(x),
          explained: explained.has(key),
        };
      });
    const bad = rows.filter((x) => !x.ok && !x.explained);
    return {
      ok: !rows.some((x) => !x.ok),
      summary: rows.length
        ? `${rows.filter((x) => x.ok).length} of ${rows.length} provider × model row(s) need nothing; tolerance ±${r.tolerancePct}%`
        : 'Nothing to reconcile in the month',
      problems: bad.map(
        (x) =>
          `${x.provider} ${x.model}: ${x.status.replace('_', ' ')} (estimated ${Money.parse(x.estimated, USD).posted().toCsv()}, invoiced ${Money.parse(x.invoiced, USD).posted().toCsv()})`,
      ),
      rows,
    };
  }

  private async gate3(month: string): Promise<Gate> {
    const lines = await this.snapshots.monthLines(month);
    let total = Money.zero(USD);
    let un = Money.zero(USD);
    for (const l of lines) {
      total = total.plus(l.amount);
      if (l.costCenter === UNALLOCATED) un = un.plus(l.amount);
    }
    const pct = total.isZero() ? Decimal.ZERO : un.toDecimal().times('100').divide(total.toDecimal(), 2, 'halfEven');
    const limit = Decimal.parse(this.config.unallocatedPct);
    const ok = pct.abs().compare(limit) <= 0;
    const summary = `${pct.toFixed(1, 'halfEven')}% unallocated (${un.posted().toCsv()} of ${total.posted().toCsv()}), limit ${this.config.unallocatedPct}%`;
    return { ok, summary, problems: ok ? [] : [summary] };
  }

  private async gate4(month: string): Promise<Gate> {
    const first = `${month}-01T00:00:00Z`;
    const next = `${nextMonth(month)}-01T00:00:00Z`;
    const rows = await this.sql<{ what: string; n: number }[]>`
      SELECT CASE WHEN r.source = 'dev-anomaly' THEN 'dev-anomaly' ELSE ${DEV_FIXTURE} END AS what, count(*)::int AS n
      FROM cost_records r JOIN cost_record_keys k ON k.record_id = r.record_id
      WHERE r.billing_period_start = ${first}::timestamptz
        AND (coalesce(r.tags->>'origin', '') = ${DEV_FIXTURE} OR r.source = 'dev-anomaly')
        AND NOT k.is_reversal
        AND NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = r.record_id)
      GROUP BY 1
      UNION ALL
      SELECT 'dev-anomaly provisional', count(*)::int FROM provisional_usage
      WHERE source = 'dev-anomaly' AND charge_period_start >= ${first}::timestamptz
        AND charge_period_start < ${next}::timestamptz
      HAVING count(*) > 0`;
    const problems = rows.map((r) => `${r.n} live ${r.what} row(s) in ${month}`);
    return {
      ok: !problems.length,
      summary: problems.length ? problems.join('; ') : 'No dev-fixture or dev-anomaly rows in the month',
      problems,
    };
  }

  private async gate5(month: string): Promise<Gate> {
    const all = await this.anomalies.list({ status: 'all', limit: 500 });
    const open = all.filter((a) => a.windowStart.slice(0, 7) === month && a.status !== 'closed');
    const of = all.filter((a) => a.windowStart.slice(0, 7) === month).length;
    return {
      ok: !open.length,
      summary: open.length
        ? `${open.length} of ${of} anomaly(ies) of the month still open`
        : `${of} anomaly(ies) of the month, none open`,
      problems: open.map((a) => `${a.label}: ${a.status} (${a.windowStart.slice(0, 10)})`),
    };
  }

  private async gate6(): Promise<Gate> {
    const { reviews } = await this.accessReviews.list();
    const out = reviews.filter((r) => r.counts.outstanding > 0);
    const n = out.reduce((s, r) => s + r.counts.outstanding, 0);
    return {
      ok: n === 0,
      summary: n ? `${n} revoke(s) outstanding` : 'No revoke outstanding',
      problems: out.map(
        (r) => `${r.quarter}: ${r.counts.outstanding} revoke(s) attested but the access is still there`,
      ),
    };
  }

  // Steps 7–10 ------------------------------------------------------------------------------------------------------

  private async gate7(month: string): Promise<Gate> {
    const a = await this.accruals.accepted(month);
    const s = await this.snapshots.latest(month);
    if (!a || !s)
      return { ok: false, summary: 'No accrual accepted yet', problems: ["The month's accrual isn't accepted"] };
    const current = await this.snapshots.isCurrent(s);
    if (a.snapshotSha256 !== s.sha256 || !current)
      return {
        ok: false,
        summary: 'The figures moved since the snapshot',
        problems: ["The month's figures moved since the accrual was accepted: propose it again"],
      };
    return {
      ok: true,
      summary: `v${a.version}, ${Money.parse(a.total, USD).posted().toCsv()} accrued; snapshot ${s.sha256.slice(0, 12)}…`,
      problems: [],
      by: a.acceptedBy,
      at: a.acceptedAt,
    };
  }

  private async gate8(month: string): Promise<Gate & { acceptedAt: string | null }> {
    const g = await this.notes.gate(month);
    if (!g.needed)
      return {
        ok: false,
        summary: 'No snapshot yet',
        problems: ['The accrual (step 7) freezes the snapshot first'],
        acceptedAt: null,
      };
    return {
      ok: !g.missing.length,
      summary: `${g.accepted.length} of ${g.needed} note(s) accepted`,
      problems: g.missing.map((c) => `The ${c === 'TOTAL' ? "month's" : `${c}`} note isn't accepted`),
      by: g.by,
      at: g.at,
      acceptedAt: g.at,
    };
  }

  private async gate9(month: string, notesAt: string | null): Promise<Gate> {
    const s = await this.snapshots.latest(month);
    if (!s) return { ok: false, summary: 'No snapshot yet', problems: ['Nothing to upload before the snapshot'] };
    const [u] = await this.sql<{ uploaded_at: Date; email: string | null; status: number }[]>`
      SELECT d.uploaded_at, u.email, d.status FROM datarails_uploads d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.snapshot_id = ${s.id} AND d.ok
        AND (${notesAt}::timestamptz IS NULL OR d.uploaded_at >= ${notesAt}::timestamptz)
      ORDER BY d.uploaded_at DESC LIMIT 1`;
    if (!u)
      return {
        ok: false,
        summary: 'Not uploaded',
        problems: [
          notesAt ? 'Upload the snapshot and the accepted notes to Datarails' : 'Accept the notes, then upload',
        ],
      };
    return {
      ok: true,
      summary: `Uploaded (HTTP ${u.status})`,
      problems: [],
      by: u.email,
      at: u.uploaded_at.toISOString(),
    };
  }

  // The view ----------------------------------------------------------------------------------------------------------

  private async explanations(month: string, round: number): Promise<ExplRow[]> {
    return this.sql<ExplRow[]>`
      SELECT e.id, e.step, e.row_key, e.note, u.email, u.name, e.explained_at
      FROM close_explanations e JOIN users u ON u.id = e.explained_by
      WHERE e.month = ${`${month}-01`} AND e.round = ${round} ORDER BY e.explained_at`;
  }

  private async locks(month: string): Promise<LockRow[]> {
    return this.sql<LockRow[]>`
      SELECT l.*, s.sha256 AS snapshot_sha FROM close_locks l LEFT JOIN close_snapshots s ON s.id = l.snapshot_id
      WHERE l.month = ${`${month}-01`} ORDER BY l.round`;
  }

  private async signoffs(month: string, round: number, tx: Tx = this.sql): Promise<LockSignoff[]> {
    const rows = await tx<
      { person_id: string; name: string; email: string | null; role: 'controller' | 'cfo'; signed_at: Date }[]
    >`
      SELECT s.person_id, u.name, u.email, s.role, s.signed_at FROM close_signoffs s JOIN users u ON u.id = s.person_id
      WHERE s.month = ${`${month}-01`} AND s.round = ${round} ORDER BY s.signed_at`;
    return rows.map((r) => ({
      person: { id: r.person_id, name: r.name, email: r.email },
      role: r.role,
      at: r.signed_at.toISOString(),
    }));
  }

  /** Steps 1–6 as they stand now, with this round's explanations: what the accrual's acceptance needs. */
  private async liveSteps(month: string, round: number, upTo: number): Promise<CloseStepView[]> {
    const expl = await this.explanations(month, round);
    const rowExpl = new Set(expl.filter((e) => e.step === 'reconciled' && e.row_key).map((e) => e.row_key!));
    const at = this.now().toISOString();
    const gates: Partial<Record<CloseStepKey, Gate>> = {};
    [
      gates.usage_ingested,
      gates.reconciled,
      gates.unallocated,
      gates.no_dev_rows,
      gates.no_open_anomalies,
      gates.no_outstanding_revokes,
    ] = await Promise.all([
      this.gate1(month),
      this.gate2(month, rowExpl),
      this.gate3(month),
      this.gate4(month),
      this.gate5(month),
      this.gate6(),
    ]);
    if (upTo >= 7) {
      gates.accrual_accepted = await this.gate7(month);
      const g8 = await this.gate8(month);
      gates.notes_accepted = g8;
      gates.datarails_uploaded = await this.gate9(month, g8.acceptedAt);
    }
    const steps: CloseStepView[] = [];
    let blocked = false;
    for (const [i, key] of STEP_ORDER.slice(0, upTo).entries()) {
      const g = gates[key]!;
      const mine = expl.filter((e) => e.step === key);
      const explainable = EXPLAINABLE_STEPS.includes(key);
      const explained =
        explainable &&
        (key === 'reconciled'
          ? g.rows!.every((r) => r.ok || r.explained) && g.rows!.some((r) => !r.ok)
          : mine.some((e) => !e.row_key));
      let state: CloseStepView['state'] = g.ok ? 'done' : explained ? 'explained' : 'red';
      if (i >= 6 && blocked && state === 'red') state = 'waiting';
      if (state === 'red' || state === 'waiting') blocked = true;
      const last = mine.at(-1);
      steps.push({
        number: i + 1,
        key,
        title: STEP_TITLES[key],
        state,
        summary: g.summary,
        problems: state === 'done' ? [] : g.problems,
        by: g.ok ? (g.by ?? 'Landledger') : state === 'explained' ? (last?.email ?? last?.name ?? null) : null,
        at: g.ok ? (g.at ?? at) : state === 'explained' ? (last?.explained_at.toISOString() ?? null) : null,
        explainable,
        explanations: mine.map((e) => ({
          id: e.id,
          step: e.step,
          rowKey: e.row_key,
          note: e.note,
          by: e.email ?? e.name,
          at: e.explained_at.toISOString(),
        })),
        ...(g.rows ? { rows: g.rows } : {}),
      });
    }
    return steps;
  }

  /** The gates for the accrual (spec 013): steps 1–6 each done or explained. */
  async gates(month: string): Promise<{
    ok: boolean;
    problems: string[];
    gates: Array<{ key: CloseStepKey; state: CloseStepView['state']; summary: string }>;
  }> {
    const p = await this.period(month);
    const steps = p.reopened
      ? (await this.locks(month)).at(-1)!.gates.slice(0, 6)
      : await this.liveSteps(month, p.round, 6);
    const red = steps.filter((s) => s.state !== 'done' && s.state !== 'explained');
    return {
      ok: !red.length,
      problems: red.map((s) => `step ${s.number} (${s.title}): ${s.problems[0] ?? s.summary}`),
      gates: steps.map((s) => ({ key: s.key, state: s.state, summary: s.summary })),
    };
  }

  async view(month: string): Promise<CloseView> {
    const p = await this.period(month);
    const locks = await this.locks(month);
    const signoffs = await this.signoffs(month, p.round);
    let steps: CloseStepView[];
    if (p.status === 'locked' && !p.reopened) steps = locks.at(-1)?.gates ?? [];
    else if (p.reopened) {
      // The ledger is closed to inserts: steps 1–6 stand as they were locked; 7–9 can be done again.
      const was = locks.at(-1)!;
      const live = (await this.liveSteps(month, p.round, 9)).slice(6);
      steps = [
        ...was.gates.slice(0, 6).map((s) => ({ ...s, summary: `${s.summary} (as locked in round ${was.round})` })),
        ...live,
      ];
      steps.push(
        this.lockStep(
          signoffs,
          live.some((s) => s.state === 'red' || s.state === 'waiting'),
        ),
      );
    } else {
      const live = await this.liveSteps(month, p.round, 9);
      steps = [
        ...live,
        this.lockStep(
          signoffs,
          live.some((s) => s.state === 'red' || s.state === 'waiting'),
        ),
      ];
    }
    // Locks stored before the lock step itself was done carry it as waiting: show the lock as done.
    if (p.status === 'locked' && !p.reopened && locks.length) {
      const l = locks.at(-1)!;
      steps = steps.map((s) =>
        s.key === 'locked'
          ? {
              ...s,
              state: 'done',
              summary: `Locked by ${l.signoffs.map((x) => x.person.name).join(' and ')}`,
              problems: [],
              by: l.signoffs.at(-1)?.person.email ?? null,
              at: l.locked_at.toISOString(),
            }
          : s,
      );
    }
    const done = steps.filter((s) => s.state === 'done' || s.state === 'explained').length;
    const snap = await this.snapshots.latest(month);
    const anchors = await Promise.all(locks.map((l) => this.anchorOf(Number(l.audit_seq))));
    const reopens = await this.sql<
      {
        round: number;
        request_id: string;
        number: string | null;
        reason: string;
        requester: string | null;
        approver: string | null;
        reopened_at: Date;
      }[]
    >`
      SELECT p.round, p.request_id, r.number, p.reason, ru.email AS requester, au.email AS approver, p.reopened_at
      FROM period_reopens p JOIN requests r ON r.id = p.request_id
      LEFT JOIN users ru ON ru.id = p.requested_by LEFT JOIN users au ON au.id = p.approved_by
      WHERE p.month = ${`${month}-01`} ORDER BY p.round`;
    const [pending] = await this.sql<{ id: string; number: string | null }[]>`
      SELECT id, number FROM requests WHERE kind = 'period_reopen' AND change->>'month' = ${month}
        AND status IN ('draft', 'pending', 'awaiting_confirmation') ORDER BY created_at DESC LIMIT 1`;
    return {
      month,
      status: p.status,
      reopened: p.reopened,
      round: p.round,
      ended: this.ended(month),
      dryRun: p.status === 'open',
      steps,
      done,
      next: steps.find((s) => s.state !== 'done' && s.state !== 'explained')?.key ?? null,
      snapshot: snap
        ? {
            id: snap.id,
            sha256: snap.sha256,
            frozenAt: snap.frozen_at.toISOString(),
            frozenBy: snap.frozen_email ?? snap.frozen_by,
            current: p.status === 'locked' && !p.reopened ? true : await this.snapshots.isCurrent(snap),
          }
        : null,
      signoffs: p.status === 'locked' && !p.reopened ? (locks.at(-1)?.signoffs ?? []) : signoffs,
      locks: locks.map((l, i) => ({
        round: l.round,
        at: l.locked_at.toISOString(),
        signoffs: l.signoffs,
        auditSeq: Number(l.audit_seq),
        auditHash: l.audit_hash,
        anchor: anchors[i]!,
        snapshotSha256: l.snapshot_sha,
      })),
      reopens: reopens.map((r) => ({
        round: r.round,
        requestId: r.request_id,
        number: r.number === null ? null : Number(r.number),
        reason: r.reason,
        requestedBy: r.requester ?? '',
        approvedBy: r.approver,
        at: r.reopened_at.toISOString(),
      })),
      pendingReopen: pending
        ? { requestId: pending.id, number: pending.number === null ? null : Number(pending.number) }
        : null,
      unallocatedLimitPct: this.config.unallocatedPct,
    };
  }

  private lockStep(signoffs: LockSignoff[], blocked: boolean): CloseStepView {
    const roles = new Set(signoffs.map((s) => s.role));
    const missing = (['controller', 'cfo'] as const).filter((r) => !roles.has(r));
    return {
      number: 10,
      key: 'locked',
      title: STEP_TITLES.locked,
      state: blocked ? 'waiting' : 'red',
      summary: signoffs.length
        ? `Signed by ${signoffs.map((s) => `${s.person.name} (${s.role === 'cfo' ? 'CFO' : 'controller'})`).join(', ')}; waiting for the ${missing.map((r) => (r === 'cfo' ? 'CFO' : 'controller')).join(' and ')}`
        : 'Two people sign: a controller and the CFO',
      problems: missing.map((r) => `The ${r === 'cfo' ? 'CFO' : 'controller'}'s signature`),
      by: null,
      at: null,
      explainable: false,
      explanations: [],
    };
  }

  private async anchorOf(seq: number): Promise<{ seq: number; hash: string; at: string } | null> {
    const [a] = await this.sql<{ seq: string; hash: string; anchored_at: Date }[]>`
      SELECT seq, hash, anchored_at FROM audit_anchors WHERE seq >= ${seq} ORDER BY seq, id LIMIT 1`;
    return a ? { seq: Number(a.seq), hash: a.hash, at: new Date(a.anchored_at).toISOString() } : null;
  }

  // Acting ------------------------------------------------------------------------------------------------------------

  private person(by: Principal, roles: readonly string[], what: string) {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', `A person signed in with Landbright ${what}; an API key never does`);
    if (!by.roles.some((r) => roles.includes(r)))
      throw new ApiError(
        'forbidden',
        `${what[0]!.toUpperCase()}${what.slice(1)} is for ${roles.join(', ')}`.replace('fpa', 'FP&A'),
      );
  }

  /** open → closing: a controller or the CFO starts the close once the month has ended. */
  async start(month: string, note: string, by: Principal): Promise<CloseView> {
    this.person(by, ['controller', 'cfo'], 'starts a close');
    if (month > this.now().toISOString().slice(0, 7)) throw new ApiError('bad_request', `${month} hasn't started yet`);
    if (!this.ended(month))
      throw new ApiError('conflict', `${month} hasn't ended yet: its close starts on ${nextMonth(month)}-01`);
    await this.periods.advance(month, 'closing', by);
    if (note)
      await this.audit.append({
        ...actorOf(by),
        action: 'close.started',
        subjectType: 'period',
        subjectId: month,
        data: { note },
      });
    return this.view(month);
  }

  /** A red step explained with a note (audited). Never step 4 or 10; step 2 one row at a time. */
  async explain(
    month: string,
    input: { step: CloseStepKey; rowKey?: string; note: string },
    by: Principal,
  ): Promise<CloseView> {
    this.person(by, ['controller', 'cfo', 'fpa'], 'explains a step');
    if (!EXPLAINABLE_STEPS.includes(input.step))
      throw new ApiError(
        'bad_request',
        `Step "${STEP_TITLES[input.step]}" is never explained: it is done or the month isn't closed`,
      );
    const p = await this.period(month);
    if (p.status === 'open') throw new ApiError('conflict', `${month}'s close hasn't started: this is a dry run`);
    if (p.status === 'locked' && !p.reopened) throw new ApiError('conflict', `${month} is locked`);
    if (p.reopened && STEP_ORDER.indexOf(input.step) < 6)
      throw new ApiError('conflict', `${month} is reopened: steps 1–6 stand as they were locked`);
    const view = await this.view(month);
    const step = view.steps.find((s) => s.key === input.step)!;
    if (step.state === 'done') throw new ApiError('conflict', `Step ${step.number} is done: nothing to explain`);
    if (step.state === 'waiting') throw new ApiError('conflict', `Step ${step.number} waits for an earlier step`);
    if (input.step === 'reconciled') {
      if (!input.rowKey)
        throw new ApiError('bad_request', 'Step 2 is explained one row at a time: name its rowKey (provider|model)');
      const row = step.rows?.find((r) => r.key === input.rowKey);
      if (!row) throw new ApiError('bad_request', `No reconciliation row ${input.rowKey} in ${month}`);
      if (row.ok) throw new ApiError('conflict', `${input.rowKey} needs nothing`);
      if (row.explained) throw new ApiError('conflict', `${input.rowKey} is explained already`);
    } else if (input.rowKey) throw new ApiError('bad_request', 'Only step 2 explains a row');
    else if (step.state === 'explained') throw new ApiError('conflict', `Step ${step.number} is explained already`);
    const id = newId('cex');
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO close_explanations (id, month, round, step, row_key, note, explained_by)
        VALUES (${id}, ${`${month}-01`}, ${p.round}, ${input.step}, ${input.rowKey ?? null}, ${input.note}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'close.explained',
          subjectType: 'period',
          subjectId: month,
          data: {
            round: p.round,
            step: input.step,
            ...(input.rowKey ? { rowKey: input.rowKey } : {}),
            note: input.note,
            problems: step.problems,
          },
        },
        tx,
      );
    });
    return this.view(month);
  }

  /**
   * A signature on the lock. The first (a controller or the CFO) waits for the second, a different person in the other
   * role; the second locks the month, writes the anchored audit entry and the lock's row.
   */
  async sign(month: string, input: { as?: 'controller' | 'cfo'; note: string }, by: Principal): Promise<LockResult> {
    this.person(by, ['controller', 'cfo'], 'signs a lock');
    const mine = (['controller', 'cfo'] as const).filter((r) => by.roles.includes(r));
    if (input.as && !mine.includes(input.as)) throw new ApiError('forbidden', `You don't hold the ${input.as} role`);
    const p = await this.period(month);
    if (p.status === 'open')
      throw new ApiError('conflict', `Start ${month}'s close first: a month moves open → closing → locked`);
    if (p.status === 'locked' && !p.reopened)
      throw new ApiError('conflict', `${month} is locked: a reopen request (the CFO decides) lets it change`);
    const view = await this.view(month);
    const red = view.steps.filter((s) => s.key !== 'locked' && s.state !== 'done' && s.state !== 'explained');
    if (red.length)
      throw new ApiError(
        'conflict',
        `${month} isn't ready to lock: ${red.map((s) => `step ${s.number} (${s.title})`).join(', ')} not done or explained`,
        { problems: red.flatMap((s) => s.problems.map((x) => `step ${s.number}: ${x}`)) },
      );
    if (view.snapshot && !view.snapshot.current)
      throw new ApiError('conflict', "The month's figures moved since the snapshot: propose the accrual again");
    const first = `${month}-01`;
    const result = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`period:${month}`}))`;
      const already = await this.signoffs(month, p.round, tx);
      if (already.some((s) => s.person.id === by.id))
        throw new ApiError('conflict', 'You signed this lock already: a second, different person signs it');
      const taken = new Set(already.map((s) => s.role));
      const role = input.as ?? mine.find((r) => !taken.has(r));
      if (!role || taken.has(role))
        throw new ApiError(
          'conflict',
          `The ${role === 'cfo' ? 'CFO' : 'controller'} signed already: the lock needs the other role`,
        );
      if (p.round === 0) {
        const [earlier] = await tx<{ month: Date }[]>`
          SELECT month FROM periods WHERE month < ${first} AND status <> 'locked' ORDER BY month LIMIT 1`;
        if (earlier)
          throw new ApiError('conflict', `Lock ${dayOf(earlier.month).slice(0, 7)} first: months lock in order`);
      }
      await tx`
        INSERT INTO close_signoffs (month, round, person_id, role, note)
        VALUES (${first}, ${p.round}, ${by.id}, ${role}, ${input.note})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'close.signed',
          subjectType: 'period',
          subjectId: month,
          data: { round: p.round, role, note: input.note },
        },
        tx,
      );
      const signoffs = await this.signoffs(month, p.round, tx);
      if (signoffs.length < 2) return { locked: false, signoffs, role };
      if (p.round === 0) {
        const [u] = await tx`
          UPDATE periods SET status = 'locked', locked_by = ${by.id}, locked_at = now()
          WHERE month = ${first} AND status = 'closing' RETURNING month`;
        if (!u) throw new ApiError('conflict', `${month} is not closing`);
      }
      const snap = await this.snapshots.latest(month, tx);
      const gates: CloseStepView[] = view.steps.map((s) =>
        s.key === 'locked'
          ? {
              ...s,
              state: 'done',
              summary: `Locked by ${signoffs.map((x) => x.person.name).join(' and ')}`,
              problems: [],
              by: by.email,
              at: this.now().toISOString(),
            }
          : s,
      );
      const entry = await this.audit.append(
        {
          ...actorOf(by),
          action: 'period.locked',
          subjectType: 'period',
          subjectId: month,
          data: {
            round: p.round,
            from: p.round === 0 ? 'closing' : 'reopened',
            to: 'locked',
            checks: 'four-eyes',
            signoffs: signoffs.map((s) => ({ person: s.person.email ?? s.person.id, role: s.role, at: s.at })),
            snapshotSha256: snap?.sha256 ?? null,
            gates: gates.map((g) => ({ step: g.number, key: g.key, state: g.state })),
          },
        },
        tx,
      );
      await tx`
        INSERT INTO close_locks (month, round, signoffs, gates, snapshot_id, audit_seq, audit_hash)
        VALUES (${first}, ${p.round}, ${tx.json(signoffs as never)}, ${tx.json(gates as never)}, ${snap?.id ?? null},
                ${entry.seq}, ${entry.hash})`;
      const data: PeriodLockedData = {
        month,
        round: p.round,
        signoffs,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        snapshotSha256: snap?.sha256 ?? null,
        url: `${this.config.consoleUrl}/close?month=${month}`,
      };
      await this.webhooks.enqueue(tx, 'period.locked', data as never);
      return { locked: true, signoffs, role };
    });
    let anchor: LockResult['anchor'] = null;
    if (result.locked) {
      // The lock's entry leaves the database at once: a chain cut off after it can't pass as whole.
      const a = await anchorAudit(this.sql, this.webhooks, this.log);
      const lock = (await this.locks(month)).at(-1)!;
      anchor = a ? { seq: a.seq, hash: a.hash, at: a.at } : await this.anchorOf(Number(lock.audit_seq));
    }
    const roles = new Set(result.signoffs.map((s) => s.role));
    return {
      close: await this.view(month),
      locked: result.locked,
      waitingFor: result.locked ? [] : (['controller', 'cfo'] as const).filter((r) => !roles.has(r)),
      anchor,
    };
  }

  /** A controller asks to reopen a locked month: a `period_reopen` request only the CFO decides. */
  async reopen(month: string, reason: string, by: Principal): Promise<{ close: CloseView; requestId: string }> {
    this.person(by, ['controller'], 'asks to reopen a month');
    const p = await this.period(month);
    if (p.status !== 'locked') throw new ApiError('conflict', `${month} is ${p.status}: only a locked month reopens`);
    if (p.reopened) throw new ApiError('conflict', `${month} is reopened already`);
    const view = await this.view(month);
    if (view.pendingReopen)
      throw new ApiError('conflict', `A request to reopen ${month} is pending already`, {
        requestId: view.pendingReopen.requestId,
      });
    const last = view.locks.at(-1);
    const id = await this.sql.begin((tx) =>
      this.requests.raiseChange(
        tx,
        {
          kind: 'period_reopen',
          title: `Reopen ${monthLabel(month)}`,
          note: reason,
          change: { type: 'period_reopen', month },
          evidence: {
            month,
            round: p.round + 1,
            lockedAt: last?.at ?? null,
            lockAudit: last ? { seq: last.auditSeq, hash: last.auditHash } : null,
            snapshotSha256: last?.snapshotSha256 ?? null,
            effect:
              'The ledger stays closed to inserts (corrections post to the open month); notes and the upload can be done again; two people lock it again.',
          },
          start: this.now().toISOString().slice(0, 10),
        },
        by,
      ),
    );
    await this.requests.submitById(id as string, actorOf(by));
    return { close: await this.view(month), requestId: id as string };
  }
}
