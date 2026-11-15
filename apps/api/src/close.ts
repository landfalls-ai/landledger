/**
 * The close (wave 4, spec 012). A month moves open → closing → locked through a ten-step checklist whose gates
 * Landledger computes, never ticked by hand: usage ingested, reconciled, unallocated under its limit, no dev rows, no
 * open anomalies, no outstanding revokes, the accrual accepted (which freezes the snapshot), the variance notes
 * accepted, the Datarails upload, and the lock. A red step can be explained with a note (audited), never step 4 or 10.
 * The lock takes two people, a controller and the CFO: the second signature locks the month, writes the lock's audit
 * entry and anchors it outside the database at once. A locked month reopens only by a `period_reopen` request the CFO
 * approves; its ledger stays closed to inserts (corrections post to the open month) and two people lock it again.
 *
 * Review of wave 4: each signature is on one snapshot (its sha256), by a signer who was served it; only signatures on
 * the current snapshot count, and the first signature freezes one when no accrual did. An explanation holds only while
 * the problems it explained stand. A reopened round is started again and re-runs steps 2 and 5. The lock stores the
 * round's package and its sha256. Segregation of duties: the close's start, the accrual's acceptance and the
 * controller's signature take at least two different people, besides the CFO.
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
import { localParts } from './business-hours.js';
import type { Anomalies } from './anomalies.js';
import type { AuditLog } from './audit.js';
import { canonicalJson } from './canonical.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId, sha256 } from './ids.js';
import type { IngestLog } from './ingest/runner.js';
import type { Invoices } from './invoices.js';
import type { Periods } from './ledger.js';
import { monthLabel, type Notes } from './notes.js';
import { actorOf, type Principal, refuseServiceLike } from './principal.js';
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

/** The sha256 of the problems an explanation explained (review of wave 4, should-fix 3): order does not matter. */
export const problemsSha = (problems: readonly string[]) => sha256(canonicalJson([...problems].sort()));

/** A reconciliation row's problem, as step 2 states it and as its explanation stores it. */
export const rowProblem = (x: {
  provider: string;
  model: string;
  status: string;
  estimated: string;
  invoiced: string;
}) =>
  `${x.provider} ${x.model}: ${x.status.replace('_', ' ')} (estimated ${Money.parse(x.estimated, USD).posted().toCsv()}, invoiced ${Money.parse(x.invoiced, USD).posted().toCsv()})`;

/** How long ago a signer must have been served the snapshot they sign (should-fix 1): within the last 24 hours. */
export const SEEN_WITHIN_MS = 24 * 3_600_000;

/** Steps a reopened round runs again live (should-fix 4): reconciliation and anomalies; 1, 3, 4 and 6 stand. */
const RERUN_ON_REOPEN: readonly number[] = [1, 4];

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
  problems_sha256: string | null;
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
  package_sha256: string | null;
};

/** What the lock stores of the round's package (built by MonthEndPackages, bound late). */
export type Packager = (
  month: string,
  round: number,
  signoffs: LockSignoff[],
) => Promise<{ files: unknown; manifest: string; sha256: string }>;

export class Close {
  packager: Packager | null = null;

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
    private readonly config: { consoleUrl: string; unallocatedPct: string; timeZone?: string },
    private readonly log: IngestLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** LANDLEDGER_TZ's today: a month ends in local time, as invoices read it (review of wave 4, nit). */
  private today() {
    return localParts(this.now().getTime(), this.config.timeZone ?? 'UTC').date;
  }

  private ended(month: string) {
    return this.today().slice(0, 7) > month;
  }

  // The period's state ------------------------------------------------------------------------------------------------

  /** open, closing, locked; the round (reopens so far); and whether a locked month is reopened, waiting to relock. */
  async period(
    month: string,
    tx: Tx = this.sql,
  ): Promise<{ status: 'open' | 'closing' | 'locked'; round: number; reopened: boolean; started: boolean }> {
    const first = `${month}-01`;
    const [r] = (await tx`
      SELECT (SELECT status FROM periods WHERE month = ${first}) AS status,
             (SELECT count(*)::int FROM period_reopens WHERE month = ${first}) AS reopens,
             (SELECT count(*)::int FROM close_locks l WHERE l.month = ${first} AND l.round = (
                SELECT count(*)::int FROM period_reopens WHERE month = ${first})) AS relocked,
             (SELECT count(*)::int FROM close_round_starts WHERE month = ${first}) AS starts`) as unknown as [
      { status: string | null; reopens: number; relocked: number; starts: number },
    ];
    const status = (r.status ?? 'open') as 'open' | 'closing' | 'locked';
    // Reopened: the newest round has no lock yet (a month locked before wave 4 has no close_locks row for round 0, so
    // the rounds are read by number, never by counting locks: review of wave 4, nit).
    const reopened = status === 'locked' && r.reopens > 0 && r.relocked === 0;
    // A reopened round is started again (by a controller, the CFO or FP&A) before its steps 7–10 can be done.
    const started = status === 'open' ? false : reopened ? r.starts >= r.reopens : true;
    return { status, round: r.reopens, reopened, started };
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

  /** `explained`: per row key, the problem sha256 of each of its explanations (null: from before the review). */
  private async gate2(month: string, explained: Map<string, (string | null)[]>): Promise<Gate> {
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
          // Should-fix 3: an explanation holds while the row's problem is the one it explained.
          explained: (explained.get(key) ?? []).some((sha) => sha === null || sha === problemsSha([rowProblem(x)])),
        };
      });
    const bad = rows.filter((x) => !x.ok && !x.explained);
    return {
      ok: !rows.some((x) => !x.ok),
      summary: rows.length
        ? `${rows.filter((x) => x.ok).length} of ${rows.length} provider × model row(s) need nothing; tolerance ±${r.tolerancePct}%`
        : 'Nothing to reconcile in the month',
      problems: bad.map((x) => rowProblem(x)),
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
    // Every anomaly of the month (review of wave 4, nit: not the newest 500 of all months).
    const all = await this.anomalies.list({ status: 'all', limit: 1_000_000, month });
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
    // Should-fix 6: an acceptance by an account that looks like a service (made before the rule) doesn't count.
    const service = await this.accruals.acceptedByService(a.id);
    if (service)
      return {
        ok: false,
        summary: `Accepted by ${service.name}, which looks like a service account`,
        problems: [
          `v${a.version} was accepted by ${service.name} (${service.email ?? 'no email'}), not a named person: a controller proposes and accepts it again`,
        ],
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
    // A snapshot the lock froze (should-fix 2) is no upload's: step 9 reads as before it, so its explanation holds.
    if (!s || s.reason === 'lock')
      return { ok: false, summary: 'No snapshot yet', problems: ['Nothing to upload before the snapshot'] };
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
      SELECT e.id, e.step, e.row_key, e.note, e.problems_sha256, u.email, u.name, e.explained_at
      FROM close_explanations e JOIN users u ON u.id = e.explained_by
      WHERE e.month = ${`${month}-01`} AND e.round = ${round} ORDER BY e.explained_at`;
  }

  private async locks(month: string): Promise<LockRow[]> {
    return this.sql<LockRow[]>`
      SELECT l.*, s.sha256 AS snapshot_sha FROM close_locks l LEFT JOIN close_snapshots s ON s.id = l.snapshot_id
      WHERE l.month = ${`${month}-01`} ORDER BY l.round`;
  }

  /**
   * The round's signatures that count: those on `snapshotSha` (should-fix 1). `undefined` reads every signature of the
   * round (a signature from before the review has no snapshot).
   */
  private async signoffs(
    month: string,
    round: number,
    snapshotSha: string | null | undefined,
    tx: Tx = this.sql,
  ): Promise<LockSignoff[]> {
    const rows = await tx<
      {
        person_id: string;
        name: string;
        email: string | null;
        role: 'controller' | 'cfo';
        signed_at: Date;
        snapshot_sha256: string | null;
        seen_at: Date | null;
      }[]
    >`
      SELECT s.person_id, u.name, u.email, s.role, s.signed_at, s.snapshot_sha256, s.seen_at
      FROM close_signoffs s JOIN users u ON u.id = s.person_id
      WHERE s.month = ${`${month}-01`} AND s.round = ${round}
        AND (${snapshotSha === undefined} OR s.snapshot_sha256 IS NOT DISTINCT FROM ${snapshotSha ?? null})
      ORDER BY s.signed_at`;
    return rows.map((r) => ({
      person: { id: r.person_id, name: r.name, email: r.email },
      role: r.role,
      at: r.signed_at.toISOString(),
      snapshotSha256: r.snapshot_sha256,
      seenAt: r.seen_at?.toISOString() ?? null,
    }));
  }

  /**
   * Segregation of duties (review of wave 4): who started the round (the close's start, or a reopened round's start),
   * who accepted the accrual the newest snapshot froze, and who signed as controller on it.
   */
  async duties(
    month: string,
    round: number,
    tx: Tx = this.sql,
  ): Promise<{
    started: { id: string; label: string } | null;
    accrual: { id: string; label: string } | null;
    controller: { id: string; label: string } | null;
  }> {
    const first = `${month}-01`;
    const label = (r: { id: string | null; email: string | null; name: string | null } | undefined) =>
      r?.id ? { id: r.id, label: r.email ?? r.name ?? r.id } : null;
    const [st] =
      round === 0
        ? await tx<{ id: string | null; email: string | null; name: string | null }[]>`
            SELECT p.closing_by AS id, u.email, u.name FROM periods p LEFT JOIN users u ON u.id = p.closing_by
            WHERE p.month = ${first}`
        : await tx<{ id: string | null; email: string | null; name: string | null }[]>`
            SELECT s.started_by AS id, u.email, u.name FROM close_round_starts s LEFT JOIN users u ON u.id = s.started_by
            WHERE s.month = ${first} AND s.round = ${round}`;
    const snap = await this.snapshots.latest(month, tx);
    const [ac] = snap?.accrual_id
      ? await tx<{ id: string | null; email: string | null; name: string | null }[]>`
          SELECT d.decided_by AS id, u.email, u.name FROM accrual_decisions d LEFT JOIN users u ON u.id = d.decided_by
          WHERE d.accrual_id = ${snap.accrual_id} AND d.outcome = 'accepted'`
      : [];
    const ctl = (await this.signoffs(month, round, snap?.sha256 ?? null, tx)).find((x) => x.role === 'controller');
    return {
      started: label(st),
      accrual: label(ac),
      controller: ctl ? { id: ctl.person.id, label: ctl.person.email ?? ctl.person.name } : null,
    };
  }

  /** Steps 1–6 as they stand now, with this round's explanations: what the accrual's acceptance needs. */
  private async liveSteps(month: string, round: number, upTo: number): Promise<CloseStepView[]> {
    const expl = await this.explanations(month, round);
    const rowExpl = new Map<string, (string | null)[]>();
    for (const e of expl.filter((x) => x.step === 'reconciled' && x.row_key))
      rowExpl.set(e.row_key!, [...(rowExpl.get(e.row_key!) ?? []), e.problems_sha256]);
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
          : // Should-fix 3: an explanation holds while the step's problems are the ones it explained.
            mine.some(
              (e) => !e.row_key && (e.problems_sha256 === null || e.problems_sha256 === problemsSha(g.problems)),
            ));
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

  /**
   * Steps 1–`upTo` of a reopened round (should-fix 4): 1, 3, 4 and 6 stand as the last lock had them (the ledger is
   * closed to inserts); 2 and 5 run again live, as do 7–9. A month locked before wave 4 has no lock row: all run live.
   */
  private async reopenedSteps(month: string, round: number, upTo: number): Promise<CloseStepView[]> {
    const was = (await this.locks(month)).at(-1);
    const live = await this.liveSteps(month, round, upTo);
    if (!was) return live;
    return live.map((s, i) =>
      i < 6 && !RERUN_ON_REOPEN.includes(i) && was.gates[i]
        ? { ...was.gates[i]!, summary: `${was.gates[i]!.summary} (as locked in round ${was.round})` }
        : s,
    );
  }

  /** The gates for the accrual (spec 013): steps 1–6 each done or explained. */
  async gates(month: string): Promise<{
    ok: boolean;
    problems: string[];
    gates: Array<{ key: CloseStepKey; state: CloseStepView['state']; summary: string }>;
  }> {
    const p = await this.period(month);
    const steps = p.reopened ? await this.reopenedSteps(month, p.round, 6) : await this.liveSteps(month, p.round, 6);
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
    const snap = await this.snapshots.latest(month);
    const signoffs = await this.signoffs(month, p.round, snap?.sha256 ?? null);
    let steps: CloseStepView[];
    if (p.status === 'locked' && !p.reopened) steps = locks.at(-1)?.gates ?? [];
    else if (p.reopened) {
      // The ledger is closed to inserts: steps 1, 3, 4 and 6 stand as they were locked; 2, 5 and 7–9 run again.
      const live = await this.reopenedSteps(month, p.round, 9);
      steps = [
        ...live,
        this.lockStep(
          signoffs,
          !p.started || live.some((s) => s.state === 'red' || s.state === 'waiting'),
          p.started ? null : `Round ${p.round} isn't started yet: a controller, the CFO or FP&A starts it`,
        ),
      ];
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
    const duties = await this.duties(month, p.round);
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
      roundStarted: p.started,
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
        packageSha256: l.package_sha256,
      })),
      duties: {
        startedBy: duties.started?.label ?? null,
        accrualAcceptedBy: duties.accrual?.label ?? null,
        controllerSignedBy: duties.controller?.label ?? null,
      },
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

  private lockStep(signoffs: LockSignoff[], blocked: boolean, why: string | null = null): CloseStepView {
    const roles = new Set(signoffs.map((s) => s.role));
    const missing = (['controller', 'cfo'] as const).filter((r) => !roles.has(r));
    return {
      number: 10,
      key: 'locked',
      title: STEP_TITLES.locked,
      state: blocked ? 'waiting' : 'red',
      summary: why
        ? why
        : signoffs.length
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

  /**
   * open → closing: a controller, the CFO or FP&A starts the close once the month has ended (no money moves; the
   * duties rule counts the starter). On a reopened month, the same call starts the new round.
   */
  async start(month: string, note: string, by: Principal): Promise<CloseView> {
    this.person(by, ['controller', 'cfo', 'fpa'], 'starts a close');
    refuseServiceLike(by, 'starts a close');
    if (month > this.today().slice(0, 7)) throw new ApiError('bad_request', `${month} hasn't started yet`);
    if (!this.ended(month))
      throw new ApiError('conflict', `${month} hasn't ended yet: its close starts on ${nextMonth(month)}-01`);
    const p = await this.period(month);
    if (p.reopened) {
      if (p.started) throw new ApiError('conflict', `Round ${p.round} of ${month}'s close is started already`);
      await this.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`period:${month}`}))`;
        await tx`
          INSERT INTO close_round_starts (month, round, started_by, note)
          VALUES (${`${month}-01`}, ${p.round}, ${by.id}, ${note}) ON CONFLICT DO NOTHING`;
        await this.audit.append(
          {
            ...actorOf(by),
            action: 'close.round_started',
            subjectType: 'period',
            subjectId: month,
            data: { round: p.round, note },
          },
          tx,
        );
      });
      return this.view(month);
    }
    await this.periods.advance(month, 'closing', by, undefined, { fpaStarts: true });
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

  /**
   * Records that a person was served the month's newest snapshot (the close page, the snapshot or the package): the
   * evidence a signature needs that its signer saw what they signed (review of wave 4, should-fix 1).
   */
  async served(month: string, by: Principal): Promise<void> {
    if (by.kind !== 'person') return;
    const snap = await this.snapshots.latest(month);
    if (!snap) return;
    await this.sql`
      INSERT INTO close_snapshot_views (id, month, snapshot_id, person_id, served_at)
      VALUES (${newId('csv')}, ${`${month}-01`}, ${snap.id}, ${by.id}, ${this.now()})`;
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
    if (p.reopened && !p.started) throw new ApiError('conflict', `Start round ${p.round} of ${month}'s close first`);
    const at = STEP_ORDER.indexOf(input.step);
    if (p.reopened && at < 6 && !RERUN_ON_REOPEN.includes(at))
      throw new ApiError('conflict', `${month} is reopened: steps 1, 3, 4 and 6 stand as they were locked`);
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
    // Should-fix 3: what is explained is stored with it; a changed list turns the step (or row) red again.
    const explainedProblems = input.rowKey
      ? [rowProblem(step.rows!.find((r) => r.key === input.rowKey)!)]
      : step.problems;
    const id = newId('cex');
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO close_explanations (id, month, round, step, row_key, note, explained_by, problems, problems_sha256)
        VALUES (${id}, ${`${month}-01`}, ${p.round}, ${input.step}, ${input.rowKey ?? null}, ${input.note}, ${by.id},
                ${tx.json(explainedProblems as never)}, ${problemsSha(explainedProblems)})`;
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
            problems: explainedProblems,
            problemsSha256: problemsSha(explainedProblems),
          },
        },
        tx,
      );
    });
    return this.view(month);
  }

  /**
   * A signature on the lock. The first (a controller or the CFO) waits for the second, a different person in the other
   * role; the second locks the month, stores the round's package, writes the anchored audit entry and the lock's row.
   *
   * Review of wave 4: the signature names the snapshot it is on (409 if it is not the current one) and its signer must
   * have been served that snapshot (should-fix 1); with no snapshot yet, the first signature freezes one (should-fix
   * 2); the gates are read under the period's and the accrual's locks (nit); a controller's signature keeps the duties
   * rule. Only signatures on the current snapshot count.
   */
  async sign(
    month: string,
    input: { as?: 'controller' | 'cfo'; note: string; snapshotSha256?: string | null },
    by: Principal,
  ): Promise<LockResult> {
    this.person(by, ['controller', 'cfo'], 'signs a lock');
    refuseServiceLike(by, 'signs a lock');
    const mine = (['controller', 'cfo'] as const).filter((r) => by.roles.includes(r));
    if (input.as && !mine.includes(input.as)) throw new ApiError('forbidden', `You don't hold the ${input.as} role`);
    const first = `${month}-01`;
    const result = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`period:${month}`}))`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`accruals:${month}`}))`;
      const p = await this.period(month, tx);
      if (p.status === 'open')
        throw new ApiError('conflict', `Start ${month}'s close first: a month moves open → closing → locked`);
      if (p.status === 'locked' && !p.reopened)
        throw new ApiError('conflict', `${month} is locked: a reopen request (the CFO decides) lets it change`);
      if (!p.started) throw new ApiError('conflict', `Start round ${p.round} of ${month}'s close first`);
      const view = await this.view(month);
      const red = view.steps.filter((s) => s.key !== 'locked' && s.state !== 'done' && s.state !== 'explained');
      if (red.length)
        throw new ApiError(
          'conflict',
          `${month} isn't ready to lock: ${red.map((s) => `step ${s.number} (${s.title})`).join(', ')} not done or explained`,
          { problems: red.flatMap((s) => s.problems.map((x) => `step ${s.number}: ${x}`)) },
        );
      let snap = await this.snapshots.latest(month, tx);
      if (snap && !(await this.snapshots.isCurrent(snap)))
        throw new ApiError('conflict', "The month's figures moved since the snapshot: propose the accrual again");
      let seenAt: Date | null = null;
      if (snap) {
        if (input.snapshotSha256 !== snap.sha256)
          throw new ApiError(
            'conflict',
            input.snapshotSha256
              ? 'The snapshot changed since it was shown to you: reload the close and sign what it shows'
              : 'Name the snapshot you sign (its sha256, as the close shows it)',
            { snapshotSha256: snap.sha256 },
          );
        const [v] = await tx<{ at: Date | null }[]>`
          SELECT max(served_at) AS at FROM close_snapshot_views WHERE snapshot_id = ${snap.id} AND person_id = ${by.id}`;
        if (!v?.at || this.now().getTime() - v.at.getTime() > SEEN_WITHIN_MS)
          throw new ApiError(
            'conflict',
            "You haven't been shown this snapshot in the last 24 hours: open the close (or the snapshot) and sign it there",
            { snapshotSha256: snap.sha256 },
          );
        seenAt = v.at;
      } else {
        if (input.snapshotSha256)
          throw new ApiError(
            'conflict',
            `${month} has no snapshot yet: sign without one and this signature freezes it`,
          );
        // Should-fix 2: steps 7–9 were explained, so no accrual froze a snapshot: the first signature freezes one.
        const frozen = await this.snapshots.freezeIn(tx, month, {
          accrual: null,
          gates: view.steps.slice(0, 6).map((s) => ({ key: s.key, state: s.state, summary: s.summary })),
          by: { id: by.id, actor: actorOf(by).actor },
          accrualId: null,
          reason: 'lock',
        });
        snap = (await this.snapshots.byId(frozen.id, tx))!;
      }
      const already = await this.signoffs(month, p.round, snap.sha256, tx);
      if (already.some((s) => s.person.id === by.id))
        throw new ApiError('conflict', 'You signed this lock already: a second, different person signs it');
      const taken = new Set(already.map((s) => s.role));
      const role = input.as ?? mine.find((r) => !taken.has(r));
      if (!role || taken.has(role))
        throw new ApiError(
          'conflict',
          `The ${role === 'cfo' ? 'CFO' : 'controller'} signed already: the lock needs the other role`,
        );
      if (role === 'controller') {
        // Segregation of duties: the start, the accrual's acceptance and this signature take two people at least.
        const d = await this.duties(month, p.round, tx);
        const people = new Set([d.started?.id, d.accrual?.id, by.id].filter((x): x is string => !!x));
        if (people.size < 2)
          throw new ApiError(
            'conflict',
            `Segregation of duties: you ${d.started ? 'started this round of the close' : ''}${d.started && d.accrual ? ' and ' : ''}${d.accrual ? "accepted the month's accrual" : ''}; another controller signs it, or another person does one of those steps`,
            { startedBy: d.started?.label ?? null, accrualAcceptedBy: d.accrual?.label ?? null },
          );
      }
      if (p.round === 0) {
        const [earlier] = await tx<{ month: Date }[]>`
          SELECT month FROM periods WHERE month < ${first} AND status <> 'locked' ORDER BY month LIMIT 1`;
        if (earlier)
          throw new ApiError('conflict', `Lock ${dayOf(earlier.month).slice(0, 7)} first: months lock in order`);
      }
      await tx`
        INSERT INTO close_signoffs (month, round, person_id, role, note, snapshot_sha256, seen_at)
        VALUES (${first}, ${p.round}, ${by.id}, ${role}, ${input.note}, ${snap.sha256}, ${seenAt})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'close.signed',
          subjectType: 'period',
          subjectId: month,
          data: {
            round: p.round,
            role,
            note: input.note,
            snapshotSha256: snap.sha256,
            seenAt: seenAt?.toISOString() ?? null,
          },
        },
        tx,
      );
      const signoffs = await this.signoffs(month, p.round, snap.sha256, tx);
      if (signoffs.length < 2) return { locked: false, signoffs, role };
      // Should-fix 5: the round's package, built now and stored; its manifest's sha256 goes in the lock's entry.
      const pkg = await this.packager!(month, p.round, signoffs);
      await tx`
        INSERT INTO close_packages (month, round, files, manifest, sha256, built_by)
        VALUES (${first}, ${p.round}, ${tx.json(pkg.files as never)}, ${pkg.manifest}, ${pkg.sha256}, ${by.id})`;
      if (p.round === 0) {
        const [u] = await tx`
          UPDATE periods SET status = 'locked', locked_by = ${by.id}, locked_at = now()
          WHERE month = ${first} AND status = 'closing' RETURNING month`;
        if (!u) throw new ApiError('conflict', `${month} is not closing`);
      }
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
            signoffs: signoffs.map((s) => ({
              person: s.person.email ?? s.person.id,
              role: s.role,
              at: s.at,
              snapshotSha256: s.snapshotSha256 ?? null,
              seenAt: s.seenAt ?? null,
            })),
            snapshotSha256: snap.sha256,
            packageSha256: pkg.sha256,
            gates: gates.map((g) => ({ step: g.number, key: g.key, state: g.state })),
          },
        },
        tx,
      );
      await tx`
        INSERT INTO close_locks (month, round, signoffs, gates, snapshot_id, audit_seq, audit_hash, package_sha256)
        VALUES (${first}, ${p.round}, ${tx.json(signoffs as never)}, ${tx.json(gates as never)}, ${snap.id},
                ${entry.seq}, ${entry.hash}, ${pkg.sha256})`;
      const data: PeriodLockedData = {
        month,
        round: p.round,
        signoffs,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        snapshotSha256: snap.sha256,
        url: `${this.config.consoleUrl}/close?month=${month}`,
      };
      await this.webhooks.enqueue(tx, 'period.locked', { ...data, packageSha256: pkg.sha256 } as never);
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
