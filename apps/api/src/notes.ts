/**
 * Variance notes (wave 4, spec 015). **An agent drafts; an analyst accepts.** The close's snapshot names the notes a
 * month needs (the month as a whole and each cost center with an actual or a budget) and the figures each may cite.
 * An agent's key with `notes:draft` posts a draft with the figures it cites; every cite must equal the snapshot's to
 * the cent, or the draft is refused. An analyst (FP&A or a controller, never the agent's sponsor nor the version's
 * writer) accepts it as drafted or edited, or rejects it; every version is kept. When no agent answers, a person asks
 * for drafts from the template: deterministic text from the same figures.
 */
import type {
  NoteCite,
  NoteDraftInput,
  NoteFigures,
  NotesView,
  NoteVersionView,
  NoteView,
} from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal, refuseServiceLike } from './principal.js';
import type { Snapshots } from './snapshot.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** `$1,234.56`, `−$12.00`: posted to the cent, half away from zero. */
export function usd(a: string): string {
  const m = Money.parse(a, USD).posted();
  const neg = m.sign() < 0;
  const [w, f = '00'] = m.abs().toCsv().split('.');
  return `${neg ? '−' : ''}$${w!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f.padEnd(2, '0')}`;
}
const signedUsd = (a: string) => (Money.parse(a, USD).sign() > 0 ? `+${usd(a)}` : usd(a));

/** Do two amounts agree to the cent? */
export const sameToCent = (a: string, b: string) => Money.parse(a, USD).posted().equals(Money.parse(b, USD).posted());

/** The value a cite names in a note's figures, or undefined when the figures have no such value. */
export function citedValue(f: NoteFigures, c: Pick<NoteCite, 'figure' | 'key'>): string | null | undefined {
  switch (c.figure) {
    case 'actual':
      return f.actual;
    case 'notional':
      return f.notional;
    case 'budget':
      return f.budget;
    case 'forecast_day10':
      return f.forecastDay10;
    case 'variance_budget':
      return f.varianceBudget;
    case 'variance_forecast':
      return f.varianceForecast;
    default: {
      const dim = c.figure.slice('driver_'.length);
      return f.drivers.find((d) => d.dimension === dim && d.key === c.key)?.change;
    }
  }
}

/** Each cite that doesn't match the snapshot, in words. */
export function checkCites(f: NoteFigures, cites: readonly NoteCite[]): string[] {
  const out: string[] = [];
  for (const c of cites) {
    const v = citedValue(f, c);
    const what = c.key ? `${c.figure} ${c.key}` : c.figure;
    if (v === undefined) out.push(`${what}: not among ${f.costCenter}'s figures`);
    else if (v === null) out.push(`${what}: the snapshot has none (cited ${c.amount})`);
    else if (!sameToCent(v, c.amount)) out.push(`${what}: cited ${c.amount}, the snapshot says ${v}`);
  }
  return out;
}

/**
 * The amounts a note's text states (`$1,234.56`, `−$12.00`, `+$3`, `USD 40.00`, `40.00 USD`), as decimal strings
 * without their sign. Percentages and counts are not amounts.
 */
export function amountsIn(text: string): string[] {
  const out: string[] = [];
  const num = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,6}))?';
  const patterns = [
    new RegExp(`\\$\\s?${num}`, 'g'),
    new RegExp(`\\bUSD\\s?${num}`, 'g'),
    new RegExp(`(?<![$\\d.,])${num}\\s?(?:USD|dollars?)\\b`, 'gi'),
  ];
  for (const re of patterns)
    for (const m of text.matchAll(re)) out.push(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
  return out;
}

/**
 * Should-fix 8 (review of wave 4): every amount the text states must be one the note cites, to the cent (sign aside,
 * since text says "−$12.00" or "down $12.00"). Returns the amounts that aren't, in words.
 */
export function uncitedAmounts(text: string, cites: readonly NoteCite[]): string[] {
  const cited = cites.map((c) => Money.parse(c.amount, USD).posted().abs());
  return amountsIn(text)
    .filter((a) => !cited.some((c) => c.equals(Money.parse(a, USD).posted().abs())))
    .map((a) => `$${a} is stated in the text but no cite carries it`);
}

/** The deterministic draft for a note: the same figures, in the same words, every time. */
export function templateNote(f: NoteFigures, month: string): { text: string; cites: NoteCite[] } {
  const cites: NoteCite[] = [{ figure: 'actual', amount: f.actual }];
  const parts: string[] = [];
  const who = f.costCenter === 'TOTAL' ? `Technology and AI spend` : `${f.name} (${f.costCenter})`;
  let s = `${who} came to ${usd(f.actual)} in ${monthLabel(month)}`;
  // Should-fix 13: the notional cluster cost inside the figure is named, since it is never booked.
  if (f.notional !== undefined && !Money.parse(f.notional, USD).posted().isZero()) {
    cites.push({ figure: 'notional', amount: f.notional });
    s += ` (of which ${usd(f.notional)} is notional cluster cost, never booked)`;
  }
  if (f.budget !== null && f.varianceBudget !== null) {
    cites.push({ figure: 'budget', amount: f.budget }, { figure: 'variance_budget', amount: f.varianceBudget });
    s += `, against a budget of ${usd(f.budget)} (${signedUsd(f.varianceBudget)}${f.varianceBudgetPct ? `, ${f.varianceBudgetPct}%` : ''})`;
  } else s += ', with no budget for the month';
  parts.push(`${s}.`);
  if (f.forecastDay10 !== null && f.varianceForecast !== null) {
    cites.push(
      { figure: 'forecast_day10', amount: f.forecastDay10 },
      { figure: 'variance_forecast', amount: f.varianceForecast },
    );
    parts.push(
      `The last forecast stored by day 10 was ${usd(f.forecastDay10)}; the month ended ${signedUsd(f.varianceForecast)} from it.`,
    );
  } else parts.push('No forecast was stored by day 10 of the month.');
  if (f.drivers.length) {
    const ds = f.drivers.slice(0, 4).map((d) => {
      cites.push({ figure: `driver_${d.dimension}` as NoteCite['figure'], key: d.key, amount: d.change });
      return `${d.dimension} ${d.label} ${signedUsd(d.change)}`;
    });
    parts.push(`The largest changes against the month before: ${ds.join('; ')}.`);
  } else parts.push('Nothing changed against the month before.');
  parts.push('Drafted from the template by Landledger; an analyst accepts or edits it.');
  return { text: parts.join(' '), cites };
}

type VersionRow = {
  note_id: string;
  version: number;
  snapshot_id: string;
  snapshot_sha: string;
  kind: 'draft' | 'template' | 'edit';
  body: string;
  cites: NoteCite[];
  written_by: string;
  written_by_kind: 'person' | 'key' | 'system';
  written_by_name: string;
  agent: { id: string; name: string; system: string } | null;
  sponsor_id: string | null;
  minter_id: string | null;
  sponsor_name: string | null;
  sponsor_email: string | null;
  created_at: Date;
  outcome: 'accepted' | 'rejected' | null;
  decider: string | null;
  decided_at: Date | null;
  comment: string | null;
};
type NoteRow = { id: string; month: Date; cost_center: string };

export class Notes {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly snapshots: Snapshots,
    private readonly period: (month: string, tx?: Tx) => Promise<{ status: string; reopened: boolean }>,
    private readonly consoleUrl: string,
  ) {}

  /** The month's current snapshot, refused unless it exists and its figures still hold. */
  private async snapshot(month: string, tx: Tx = this.sql) {
    const s = await this.snapshots.latest(month, tx);
    if (!s) throw new ApiError('conflict', `${month} has no snapshot yet: the accrual (step 7) freezes it`);
    return s;
  }

  private async writable(month: string) {
    const p = await this.period(month);
    if (p.status === 'open') throw new ApiError('conflict', `${month}'s close hasn't started`);
    if (p.status === 'locked' && !p.reopened)
      throw new ApiError('conflict', `${month} is locked: its notes are final (a reopen request lets them change)`);
  }

  async figures(month: string): Promise<{ snapshotSha256: string; needed: NoteFigures[] }> {
    const s = await this.snapshot(month);
    return { snapshotSha256: s.sha256, needed: s.figures.notes };
  }

  private async noteFor(tx: Tx, month: string, costCenter: string): Promise<string> {
    await tx`
      INSERT INTO variance_notes (id, month, cost_center) VALUES (${newId('note')}, ${`${month}-01`}, ${costCenter})
      ON CONFLICT (month, cost_center) DO NOTHING`;
    const [n] = await tx<{ id: string }[]>`
      SELECT id FROM variance_notes WHERE month = ${`${month}-01`} AND cost_center = ${costCenter}`;
    return n!.id;
  }

  private async nextVersion(tx: Tx, noteId: string): Promise<number> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`note:${noteId}`}))`;
    const [{ n }] = (await tx`
      SELECT coalesce(max(version), 0) + 1 AS n FROM variance_note_versions WHERE note_id = ${noteId}`) as unknown as [
      { n: number },
    ];
    return Number(n);
  }

  /** An agent's draft (a key with `notes:draft`, or an admin): every cite checked against the snapshot. */
  async draft(month: string, input: NoteDraftInput & { cites: NoteCite[] }, by: Principal): Promise<NoteView> {
    await this.writable(month);
    const s = await this.snapshot(month);
    if (input.snapshotSha256 !== s.sha256)
      throw new ApiError(
        'conflict',
        `The snapshot ${input.snapshotSha256.slice(0, 12)}… is not ${month}'s current one`,
        {
          current: s.sha256,
        },
      );
    if (!(await this.snapshots.isCurrent(s)))
      throw new ApiError(
        'conflict',
        `${month}'s figures moved since the snapshot: the accrual is proposed again first`,
      );
    const f = s.figures.notes.find((n) => n.costCenter === input.costCenter);
    if (!f) throw new ApiError('bad_request', `${month} needs no note for ${input.costCenter}`);
    const mismatches = [
      ...(input.cites.length ? [] : ['a draft cites at least one figure of the snapshot']),
      ...checkCites(f, input.cites),
      ...uncitedAmounts(input.text, input.cites),
    ];
    if (mismatches.length)
      throw new ApiError(
        'unprocessable',
        `The draft cites ${mismatches.length} figure(s) the snapshot doesn't hold: ${mismatches.join('; ')}`,
        { mismatches },
      );
    // Review of wave 4, B3: the person who minted the key is always barred from deciding its drafts; a sponsor the
    // draft declares is barred as well, never instead. A key whose minter isn't a person here drafts nothing.
    let minterId: string | null = null;
    if (by.kind === 'key') {
      const [u] = await this.sql<{ id: string }[]>`
        SELECT u.id FROM api_keys k
        JOIN users u ON u.kind = 'person' AND (u.id = k.created_by_user OR (k.created_by_user IS NULL AND lower(u.email) = lower(k.created_by)))
        WHERE k.id = ${by.id} LIMIT 1`;
      if (!u)
        throw new ApiError(
          'forbidden',
          "This key's minter is not a person in Landledger: nobody could be barred from deciding its drafts",
        );
      minterId = u.id;
    }
    let sponsorId: string | null = minterId;
    if (input.sponsor?.email || input.sponsor?.sub) {
      const [u] = await this.sql<{ id: string }[]>`
        SELECT id FROM users WHERE kind = 'person' AND active AND deleted_at IS NULL
          AND (${input.sponsor.email ?? null}::text IS NULL OR lower(email) = lower(${input.sponsor.email ?? ''}))
          AND (${input.sponsor.sub ?? null}::text IS NULL OR subject = ${input.sponsor.sub ?? ''})`;
      if (!u) throw new ApiError('bad_request', 'The sponsor is not an active person in Landledger');
      sponsorId = u.id;
    }
    const id = await this.sql.begin(async (tx) => {
      const noteId = await this.noteFor(tx, month, input.costCenter);
      const version = await this.nextVersion(tx, noteId);
      // Should-fix 7: a note accepted on the current snapshot is final for that snapshot; a new draft can't un-accept
      // it (a key is bound to no month). A new snapshot (a new accrual) asks for drafts again.
      const [last] = await tx<{ outcome: string | null; snapshot_id: string }[]>`
        SELECT v.snapshot_id, d.outcome FROM variance_note_versions v
        LEFT JOIN variance_note_decisions d ON d.note_id = v.note_id AND d.version = v.version
        WHERE v.note_id = ${noteId} ORDER BY v.version DESC LIMIT 1`;
      if (last?.outcome === 'accepted' && last.snapshot_id === s.id)
        throw new ApiError(
          'conflict',
          `The ${input.costCenter} note is accepted on ${month}'s current snapshot: it takes no new draft`,
        );
      await tx`
        INSERT INTO variance_note_versions (note_id, version, snapshot_id, kind, body, cites, written_by,
                                            written_by_kind, written_by_name, agent, sponsor_id, run_id, minter_id)
        VALUES (${noteId}, ${version}, ${s.id}, 'draft', ${input.text}, ${tx.json(input.cites as never)}, ${by.id},
                ${by.kind === 'person' ? 'person' : 'key'}, ${by.email ?? by.name},
                ${input.agent ? tx.json(input.agent as never) : null}, ${sponsorId}, ${input.runId ?? null},
                ${minterId})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'note.drafted',
          subjectType: 'variance_note',
          subjectId: noteId,
          data: {
            month,
            costCenter: input.costCenter,
            version,
            snapshotSha256: s.sha256,
            cites: input.cites.length,
            agent: input.agent?.name ?? null,
          },
        },
        tx,
      );
      return noteId;
    });
    return this.view(id);
  }

  /** The fallback when no agent answers: template drafts for every needed note with no version on this snapshot. */
  async template(month: string, costCenter: string | undefined, by: Principal): Promise<NoteView[]> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A person asks for template drafts');
    await this.writable(month);
    const s = await this.snapshot(month);
    if (!(await this.snapshots.isCurrent(s)))
      throw new ApiError(
        'conflict',
        `${month}'s figures moved since the snapshot: the accrual is proposed again first`,
      );
    const needed = s.figures.notes.filter((n) => !costCenter || n.costCenter === costCenter);
    if (costCenter && !needed.length) throw new ApiError('bad_request', `${month} needs no note for ${costCenter}`);
    const ids: string[] = [];
    await this.sql.begin(async (tx) => {
      for (const f of needed) {
        const noteId = await this.noteFor(tx, month, f.costCenter);
        const [has] = await tx`
          SELECT 1 FROM variance_note_versions WHERE note_id = ${noteId} AND snapshot_id = ${s.id} LIMIT 1`;
        if (has && !costCenter) continue;
        const t = templateNote(f, month);
        const version = await this.nextVersion(tx, noteId);
        await tx`
          INSERT INTO variance_note_versions (note_id, version, snapshot_id, kind, body, cites, written_by,
                                              written_by_kind, written_by_name, requested_by)
          VALUES (${noteId}, ${version}, ${s.id}, 'template', ${t.text}, ${tx.json(t.cites as never)}, 'landledger',
                  'system', 'Landledger template', ${by.id})`;
        await this.audit.append(
          {
            ...actorOf(by),
            action: 'note.templated',
            subjectType: 'variance_note',
            subjectId: noteId,
            data: { month, costCenter: f.costCenter, version, snapshotSha256: s.sha256 },
          },
          tx,
        );
        ids.push(noteId);
      }
    });
    return Promise.all(ids.map((id) => this.view(id)));
  }

  private async decideCheck(id: string, version: number, by: Principal, verb: string) {
    if (by.kind !== 'person') throw new ApiError('forbidden', `A person ${verb} a note; an agent's key never does`);
    if (!by.roles.some((r) => r === 'fpa' || r === 'controller'))
      throw new ApiError('forbidden', `An analyst (FP&A or a controller) ${verb} a note`);
    refuseServiceLike(by, `${verb} a note`);
    const [n] = await this.sql<NoteRow[]>`SELECT * FROM variance_notes WHERE id = ${id}`;
    if (!n) throw notFound('Note');
    const month = dayOf(n.month).slice(0, 7);
    await this.writable(month);
    const versions = await this.versions(id);
    const latest = versions.at(-1)!;
    if (latest.version !== version)
      throw new ApiError('conflict', `Version ${version} is not the latest (v${latest.version}); reopen the note`);
    if (latest.outcome) throw new ApiError('conflict', `Version ${version} is ${latest.outcome} already`);
    const s = await this.snapshot(month);
    if (latest.snapshot_id !== s.id || !(await this.snapshots.isCurrent(s)))
      throw new ApiError('conflict', "This draft cites a snapshot that isn't the month's current one: draft it again");
    if (latest.sponsor_id === by.id)
      throw new ApiError('forbidden', 'You sponsor the agent that drafted this note: another analyst decides it');
    if (latest.minter_id === by.id)
      throw new ApiError('forbidden', 'You minted the key that drafted this note: another analyst decides it');
    if (latest.written_by_kind === 'person' && latest.written_by === by.id)
      throw new ApiError('forbidden', 'You wrote this version: another analyst decides it');
    return { n, month, latest, s };
  }

  async accept(
    id: string,
    input: { version: number; text?: string; comment: string },
    by: Principal,
  ): Promise<NoteView> {
    const { n, month, latest, s } = await this.decideCheck(id, input.version, by, 'accepts');
    // Should-fix 8: edited text keeps the version's cites, so every amount it states must still be one of them.
    const text = input.text && input.text.trim() !== latest.body.trim() ? input.text : latest.body;
    const uncited = uncitedAmounts(text, latest.cites);
    if (uncited.length)
      throw new ApiError(
        'unprocessable',
        `The text states ${uncited.length} amount(s) no cite of this note carries: ${uncited.join('; ')}`,
        { mismatches: uncited },
      );
    await this.sql.begin(async (tx) => {
      let version = latest.version;
      if (input.text && input.text.trim() !== latest.body.trim()) {
        version = await this.nextVersion(tx, id);
        await tx`
          INSERT INTO variance_note_versions (note_id, version, snapshot_id, kind, body, cites, written_by,
                                              written_by_kind, written_by_name, agent, sponsor_id, minter_id)
          VALUES (${id}, ${version}, ${s.id}, 'edit', ${input.text}, ${tx.json(latest.cites as never)}, ${by.id},
                  'person', ${by.email ?? by.name}, ${latest.agent ? tx.json(latest.agent as never) : null},
                  ${latest.sponsor_id}, ${latest.minter_id})`;
      }
      await tx`
        INSERT INTO variance_note_decisions (note_id, version, outcome, decided_by, comment)
        VALUES (${id}, ${version}, 'accepted', ${by.id}, ${input.comment})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'note.accepted',
          subjectType: 'variance_note',
          subjectId: id,
          data: {
            month,
            costCenter: n.cost_center,
            version,
            edited: version !== latest.version,
            snapshotSha256: s.sha256,
          },
        },
        tx,
      );
      await this.webhooks.enqueue(tx, 'note.accepted', {
        month,
        costCenter: n.cost_center,
        noteId: id,
        version,
        url: `${this.consoleUrl}/notes?month=${month}`,
      });
    });
    return this.view(id);
  }

  async reject(id: string, input: { version: number; reason: string }, by: Principal): Promise<NoteView> {
    const { n, month } = await this.decideCheck(id, input.version, by, 'rejects');
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO variance_note_decisions (note_id, version, outcome, decided_by, comment)
        VALUES (${id}, ${input.version}, 'rejected', ${by.id}, ${input.reason})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'note.rejected',
          subjectType: 'variance_note',
          subjectId: id,
          data: { month, costCenter: n.cost_center, version: input.version, reason: input.reason },
        },
        tx,
      );
    });
    return this.view(id);
  }

  private async versions(noteId: string, tx: Tx = this.sql): Promise<VersionRow[]> {
    return tx<VersionRow[]>`
      SELECT v.*, s.sha256 AS snapshot_sha, su.name AS sponsor_name, su.email AS sponsor_email, d.outcome,
             du.email AS decider, d.decided_at, d.comment
      FROM variance_note_versions v
      JOIN close_snapshots s ON s.id = v.snapshot_id
      LEFT JOIN users su ON su.id = v.sponsor_id
      LEFT JOIN variance_note_decisions d ON d.note_id = v.note_id AND d.version = v.version
      LEFT JOIN users du ON du.id = d.decided_by
      WHERE v.note_id = ${noteId} ORDER BY v.version`;
  }

  async view(id: string, currentSnapshot?: string | null): Promise<NoteView> {
    const [n] = await this.sql<NoteRow[]>`SELECT * FROM variance_notes WHERE id = ${id}`;
    if (!n) throw notFound('Note');
    const month = dayOf(n.month).slice(0, 7);
    const snap = currentSnapshot === undefined ? ((await this.snapshots.latest(month))?.id ?? null) : currentSnapshot;
    const vs = await this.versions(id);
    const latest = vs.at(-1);
    const name =
      (await this.snapshots.latest(month))?.figures.notes.find((f) => f.costCenter === n.cost_center)?.name ??
      n.cost_center;
    const versions: NoteVersionView[] = vs.map((v) => ({
      version: v.version,
      text: v.body,
      cites: v.cites,
      kind: v.kind,
      by: v.written_by_kind === 'system' ? 'Landledger template' : v.written_by_name,
      agent: v.agent,
      sponsor: v.sponsor_id ? { id: v.sponsor_id, name: v.sponsor_name ?? v.sponsor_id, email: v.sponsor_email } : null,
      at: v.created_at.toISOString(),
      snapshotSha256: v.snapshot_sha,
      decision: v.outcome
        ? { outcome: v.outcome, by: v.decider ?? '', at: v.decided_at!.toISOString(), comment: v.comment ?? '' }
        : null,
    }));
    return {
      id: n.id,
      month,
      costCenter: n.cost_center,
      name,
      status: latest?.outcome === 'accepted' ? 'accepted' : latest?.outcome === 'rejected' ? 'rejected' : 'drafted',
      accepted: latest?.outcome === 'accepted' ? latest.version : null,
      versions,
      current: !!latest && latest.snapshot_id === snap,
    };
  }

  async list(month: string): Promise<NotesView> {
    const s = await this.snapshots.latest(month);
    const ids = await this.sql<{ id: string }[]>`
      SELECT id FROM variance_notes WHERE month = ${`${month}-01`} ORDER BY cost_center = 'TOTAL' DESC, cost_center`;
    const [req] = s
      ? await this.sql<{ sent_at: Date }[]>`SELECT sent_at FROM notes_requests WHERE snapshot_id = ${s.id}`
      : [];
    return {
      month,
      snapshotSha256: s?.sha256 ?? null,
      needed: s?.figures.notes ?? [],
      notes: await Promise.all(ids.map(({ id }) => this.view(id, s?.id ?? null))),
      requestedAt: req?.sent_at.toISOString() ?? null,
    };
  }

  /** For step 8: each needed note's state on the current snapshot. */
  async gate(
    month: string,
  ): Promise<{ needed: number; accepted: string[]; missing: string[]; at: string | null; by: string | null }> {
    const s = await this.snapshots.latest(month);
    // A snapshot the lock froze (steps 7–9 explained) asked for no notes: step 8 reads as before it (review of wave 4).
    if (!s || s.reason === 'lock') return { needed: 0, accepted: [], missing: [], at: null, by: null };
    const v = await this.list(month);
    const accepted: string[] = [];
    const missing: string[] = [];
    let at: string | null = null;
    let by: string | null = null;
    for (const f of s.figures.notes) {
      const n = v.notes.find((x) => x.costCenter === f.costCenter);
      const last = n?.versions.at(-1);
      if (n && n.current && last?.decision?.outcome === 'accepted') {
        accepted.push(f.costCenter);
        if (!at || last.decision.at > at) {
          at = last.decision.at;
          by = last.decision.by;
        }
      } else missing.push(f.costCenter);
    }
    return { needed: s.figures.notes.length, accepted, missing, at, by };
  }
}
