/**
 * The month-end package (wave 4, spec 018): one page and one download for the auditors. The page (JSON, or
 * `?format=html`, printable, one column) and the zip of CSVs hold the same facts: the snapshot and its sha256, the
 * checklist, reconciliation, the accrual and its journal entry, the accepted notes, the exceptions, the anomalies
 * closed, the decisions made in the month, the Datarails upload and the chain proof (the lock's audit entry, its
 * anchor, and the chain checked to the head). Every file in the zip is listed with its sha256 in `manifest.csv`.
 */
import type { MonthEndPackage } from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { Accruals } from './accruals.js';
import { nextMonth } from './accruals.js';
import type { Anomalies } from './anomalies.js';
import type { AuditLog } from './audit.js';
import { canonicalJson } from './canonical.js';
import type { Close } from './close.js';
import type { Datarails } from './datarails.js';
import type { Sql } from './db.js';
import type { Exceptions } from './exceptions.js';
import { type Cell, type Sheet, toCsv, zip } from './export.js';
import { sha256 } from './ids.js';
import type { Invoices } from './invoices.js';
import { monthLabel, type Notes } from './notes.js';
import type { Snapshots } from './snapshot.js';

const USD = REPORTING_CURRENCY;
const n = (a: string | null | undefined): Cell => (a == null ? '' : { number: Money.parse(a, USD).toCsv() });

export class MonthEndPackages {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly close: Close,
    private readonly snapshots: Snapshots,
    private readonly accruals: Accruals,
    private readonly notes: Notes,
    private readonly invoices: Invoices,
    private readonly exceptions: Exceptions,
    private readonly anomalies: Anomalies,
    private readonly datarails: Datarails,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The CSVs of the download, in order. */
  private async sheets(month: string, p: Omit<MonthEndPackage, 'files'>): Promise<Sheet[]> {
    const f = p.snapshot?.figures;
    const rec = f ? null : await this.invoices.reconciliation(month);
    const recRows = f?.reconciliation.rows ?? rec!.rows.filter((r) => !r.devFixture);
    const journal = p.accrual?.status === 'accepted' ? await this.accruals.journal(month) : null;
    return [
      {
        name: 'checklist',
        header: ['step', 'key', 'title', 'state', 'summary', 'by', 'at', 'explanations'],
        rows: p.close.steps.map((s) => [
          String(s.number),
          s.key,
          s.title,
          s.state,
          s.summary,
          s.by ?? '',
          s.at ?? '',
          s.explanations.map((e) => `${e.rowKey ? `${e.rowKey}: ` : ''}${e.note} (${e.by}, ${e.at})`).join(' | '),
        ]),
      },
      {
        name: 'snapshot-cost-centers',
        header: [
          'cost_center',
          'name',
          'estimated',
          'invoiced',
          'notional',
          'total',
          'budget',
          'currency',
          'snapshot_sha256',
        ],
        rows: (f?.byCostCenter ?? []).map((c) => [
          c.code,
          c.name,
          n(c.estimated),
          n(c.invoiced),
          n(c.notional),
          n(c.total),
          n(c.budget),
          USD,
          p.snapshot!.sha256,
        ]),
      },
      {
        name: 'snapshot-pl-classes',
        header: ['pl_class', 'label', 'total', 'invoiced', 'currency'],
        rows: (f?.byPlClass ?? []).map((c) => [c.key, c.label, n(c.total), n(c.invoiced), USD]),
      },
      {
        name: 'snapshot-providers',
        header: ['provider', 'estimated', 'invoiced', 'total', 'currency'],
        rows: (f?.byProvider ?? []).map((c) => [c.provider, n(c.estimated), n(c.invoiced), n(c.total), USD]),
      },
      {
        name: 'reconciliation',
        header: ['provider', 'model', 'estimated', 'invoiced', 'variance', 'status', 'currency'],
        rows: recRows.map((r) => [r.provider, r.model, n(r.estimated), n(r.invoiced), n(r.variance), r.status, USD]),
      },
      {
        name: 'accruals',
        header: ['line', 'kind', 'provider', 'item', 'cost_center', 'pl_class', 'amount', 'currency', 'reversal'],
        rows: (p.accrual?.lines ?? []).map((l) => [
          String(l.line),
          l.kind,
          l.provider,
          l.item,
          l.costCenter,
          l.plClass,
          n(l.amount),
          USD,
          l.reversal ? `${l.reversal.month} ${l.reversal.invoice}` : '',
        ]),
      },
      ...(journal
        ? [
            {
              name: 'accrual-journal-entry',
              header: [],
              rows: [],
              raw: journal.csv,
            } as Sheet & { raw: string },
          ]
        : []),
      {
        name: 'variance-notes',
        header: [
          'cost_center',
          'version',
          'kind',
          'written_by',
          'accepted_by',
          'accepted_at',
          'snapshot_sha256',
          'text',
        ],
        rows: p.notes
          .filter((x) => x.status === 'accepted')
          .map((x) => {
            const v = x.versions.find((y) => y.version === x.accepted)!;
            return [
              x.costCenter,
              String(v.version),
              v.kind,
              v.by,
              v.decision!.by,
              v.decision!.at,
              v.snapshotSha256,
              v.text,
            ];
          }),
      },
      {
        name: 'exceptions',
        header: ['cost_center', 'month', 'actual', 'budget', 'uncovered', 'currency'],
        rows: p.exceptions.map((e) => [e.costCenter, e.month, n(e.actual), n(e.budget), n(e.uncovered), USD]),
      },
      {
        name: 'anomalies-closed',
        header: ['id', 'kind', 'rule', 'key', 'outcome', 'closed_at'],
        rows: p.anomaliesClosed.map((a) => [a.id, a.kind, a.rule, a.key, a.outcome ?? '', a.at]),
      },
      {
        name: 'decisions',
        header: ['request', 'number', 'title', 'step', 'outcome', 'person', 'at'],
        rows: p.decisions.map((d) => [
          d.requestId,
          d.number === null ? '' : String(d.number),
          d.title,
          String(d.step),
          d.outcome,
          d.person,
          d.at,
        ]),
      },
      {
        name: 'datarails-uploads',
        header: ['id', 'ok', 'status', 'snapshot_sha256', 'files', 'by', 'at'],
        rows: p.uploads.map((u) => [
          u.id,
          String(u.ok),
          String(u.status),
          u.snapshotSha256,
          u.files.map((x) => `${x.name}:${x.sha256}`).join(' '),
          u.uploadedBy,
          u.uploadedAt,
        ]),
      },
      {
        name: 'chain-proof',
        header: [
          'ok',
          'checked',
          'head',
          'lock_seq',
          'lock_hash',
          'anchor_seq',
          'anchor_hash',
          'anchor_at',
          'truncated',
        ],
        rows: [
          [
            String(p.chain.ok),
            String(p.chain.checked),
            p.chain.head ?? '',
            p.chain.lock ? String(p.chain.lock.seq) : '',
            p.chain.lock?.hash ?? '',
            p.chain.anchor ? String(p.chain.anchor.seq) : '',
            p.chain.anchor?.hash ?? '',
            p.chain.anchor?.at ?? '',
            String(p.chain.truncated),
          ],
        ],
      },
    ];
  }

  private async build(month: string) {
    const close = await this.close.view(month);
    const snap = await this.snapshots.latest(month);
    const snapshot = snap ? this.snapshots.viewOf(snap, close.snapshot?.current ?? false) : null;
    const accrual = (await this.accruals.list(month)).current;
    const notes = (await this.notes.list(month)).notes;
    const ex = await this.exceptions.report({ month });
    const anomalies = (await this.anomalies.list({ status: 'all', limit: 500 })).filter(
      (a) => a.windowStart.slice(0, 7) === month && a.status === 'closed',
    );
    const decisions = await this.sql<
      {
        request_id: string;
        number: string | null;
        title: string;
        step: number;
        outcome: string;
        email: string | null;
        name: string | null;
        decided_at: Date;
      }[]
    >`
      SELECT d.request_id, r.number, r.title, d.step, d.outcome, u.email, u.name, d.decided_at
      FROM decisions d JOIN requests r ON r.id = d.request_id LEFT JOIN users u ON u.id = d.decided_by
      WHERE d.decided_at >= ${`${month}-01T00:00:00Z`}::timestamptz AND d.decided_at < ${`${nextMonth(month)}-01T00:00:00Z`}::timestamptz
      ORDER BY d.decided_at, d.id`;
    const verify = await this.audit.verify();
    const lock = close.locks.at(-1) ?? null;
    const pkg: Omit<MonthEndPackage, 'files'> = {
      month,
      generatedAt: this.now().toISOString(),
      status: close.status,
      snapshot,
      close,
      accrual,
      notes,
      exceptions: ex.rows.map((r) => ({
        costCenter: r.costCenter,
        month: r.month,
        uncovered: r.uncovered,
        actual: r.actual,
        budget: r.budget ?? null,
      })),
      anomaliesClosed: anomalies.map((a) => ({
        id: a.id,
        kind: a.kind,
        rule: a.rule,
        key: a.label,
        outcome: a.closed?.outcome ?? null,
        at: a.closed?.at ?? '',
      })),
      decisions: decisions.map((d) => ({
        requestId: d.request_id,
        number: d.number === null ? null : Number(d.number),
        title: d.title,
        step: d.step,
        outcome: d.outcome,
        person: d.email ?? d.name ?? '',
        at: d.decided_at.toISOString(),
      })),
      uploads: await this.datarails.uploads(month),
      chain: {
        ok: verify.ok,
        checked: verify.checked,
        head: verify.head,
        lock: lock ? { seq: lock.auditSeq, hash: lock.auditHash } : null,
        anchor: lock?.anchor ?? null,
        truncated: verify.truncated,
      },
    };
    return pkg;
  }

  private async filesOf(
    month: string,
    pkg: Omit<MonthEndPackage, 'files'>,
  ): Promise<Array<{ name: string; body: string; rows: number }>> {
    const sheets = await this.sheets(month, pkg);
    const files = sheets.map((s) => {
      const raw = (s as Sheet & { raw?: string }).raw;
      const body = raw ?? toCsv(s);
      return { name: `${month}/${s.name}.csv`, body, rows: raw ? raw.trim().split(/\r?\n/).length - 1 : s.rows.length };
    });
    if (pkg.snapshot)
      files.push({ name: `${month}/snapshot.json`, body: canonicalJson(pkg.snapshot.figures), rows: 1 });
    return files;
  }

  async json(month: string): Promise<MonthEndPackage> {
    const pkg = await this.build(month);
    const files = await this.filesOf(month, pkg);
    return { ...pkg, files: files.map((f) => ({ name: f.name, sha256: sha256(f.body), rows: f.rows })) };
  }

  async html(month: string): Promise<string> {
    return packageHtml(await this.json(month));
  }

  async zip(month: string): Promise<{ name: string; data: Buffer }> {
    const pkg = await this.build(month);
    const files = await this.filesOf(month, pkg);
    const withSha = files.map((f) => ({ ...f, sha256: sha256(f.body) }));
    const full: MonthEndPackage = {
      ...pkg,
      files: withSha.map((f) => ({ name: f.name, sha256: f.sha256, rows: f.rows })),
    };
    const manifest = toCsv({
      name: 'manifest',
      header: ['file', 'sha256', 'rows'],
      rows: withSha.map((f) => [f.name, f.sha256, String(f.rows)]),
    });
    return {
      name: `landledger-month-end-${month}.zip`,
      data: zip([
        ...withSha.map((f) => ({ name: f.name, data: Buffer.from(f.body, 'utf8') })),
        { name: `${month}/package.html`, data: Buffer.from(packageHtml(full), 'utf8') },
        { name: `${month}/manifest.csv`, data: Buffer.from(manifest, 'utf8') },
      ]),
    };
  }
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const usd = (a: string | null | undefined) => (a == null ? '—' : `$${Money.parse(a, USD).toCsv()}`);

/** The package as one printable page: one column, every fact with its time in UTC, nothing loaded from elsewhere. */
export function packageHtml(p: MonthEndPackage): string {
  const f = p.snapshot?.figures;
  const list = (items: string[]) => (items.length ? `<ul>${items.join('')}</ul>` : '<p class="muted">None.</p>');
  const kv = (pairs: [string, unknown][]) =>
    `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const lock = p.close.locks.at(-1);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Landledger · month-end package · ${esc(p.month)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#1b1d21}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
code{font:12px/1.4 ui-monospace,Menlo,monospace;word-break:break-all}.muted{color:#666}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}dt{color:#555}dd{margin:0}
ul{padding-left:18px}li{margin:4px 0}.card{border:1px solid #e3e3e3;border-radius:8px;padding:10px 12px;margin:8px 0}
.state{font-weight:600}.done,.explained{color:#17663a}.red{color:#a1260d}.waiting{color:#666}
@media print{body{max-width:none}}
</style></head><body>
<h1>${esc(monthLabel(p.month))}: month-end package</h1>
<p class="muted">Generated ${esc(p.generatedAt)} · status <b>${esc(p.status)}</b>${p.close.round ? ` · round ${p.close.round}` : ''} · USD</p>
<h2>Snapshot</h2>
${
  p.snapshot
    ? kv([
        ['sha256', `<code>${esc(p.snapshot.sha256)}</code>`],
        ['Frozen', `${esc(p.snapshot.frozenAt)} by ${esc(p.snapshot.frozenBy)}`],
        ['Current', p.snapshot.current ? 'yes: the live figures still hash to it' : 'no'],
        [
          'Total',
          `${usd(f!.total.total)} (estimated ${usd(f!.total.estimated)}, invoiced ${usd(f!.total.invoiced)}, notional ${usd(f!.total.notional)})`,
        ],
      ]) +
      list(
        f!.byCostCenter.map(
          (c) =>
            `<li>${esc(c.name)} (${esc(c.code)}): ${usd(c.total)}${c.budget ? `, budget ${usd(c.budget)}` : ''}</li>`,
        ),
      )
    : '<p class="muted">No snapshot yet: the accrual (step 7) freezes it.</p>'
}
<h2>Checklist</h2>
${list(
  p.close.steps.map(
    (s) =>
      `<li><span class="state ${esc(s.state)}">${s.number}. ${esc(s.title)}: ${esc(s.state)}</span><br>${esc(s.summary)}${s.by ? ` · ${esc(s.by)}` : ''}${s.at ? ` · ${esc(s.at)}` : ''}${s.explanations
        .map(
          (e) =>
            `<br><i>Explained${e.rowKey ? ` (${esc(e.rowKey)})` : ''}: “${esc(e.note)}”, ${esc(e.by)}, ${esc(e.at)}</i>`,
        )
        .join('')}</li>`,
  ),
)}
<h2>Lock</h2>
${
  lock
    ? kv([
        [
          'Signed',
          lock.signoffs
            .map((s) => `${esc(s.person.name)} (${s.role === 'cfo' ? 'CFO' : 'controller'}, ${esc(s.at)})`)
            .join('<br>'),
        ],
        ['Audit entry', `${lock.auditSeq} <code>${esc(lock.auditHash)}</code>`],
        [
          'Anchor',
          lock.anchor
            ? `${lock.anchor.seq} <code>${esc(lock.anchor.hash)}</code> at ${esc(lock.anchor.at)}`
            : 'not anchored yet',
        ],
      ])
    : `<p class="muted">Not locked${p.close.signoffs.length ? `: signed by ${p.close.signoffs.map((s) => esc(s.person.name)).join(', ')}` : ''}.</p>`
}
<h2>Reconciliation</h2>
${list((f?.reconciliation.rows ?? []).map((r) => `<li>${esc(r.provider)} ${esc(r.model)}: estimated ${usd(r.estimated)}, invoiced ${usd(r.invoiced)}, ${esc(r.status)}</li>`))}
<h2>Accrual</h2>
${
  p.accrual
    ? `<p>v${p.accrual.version}, ${esc(p.accrual.status)}, ${usd(p.accrual.total)}${p.accrual.acceptedBy ? `, accepted by ${esc(p.accrual.acceptedBy)} ${esc(p.accrual.acceptedAt)}` : ''}. sha256 <code>${esc(p.accrual.sha256)}</code></p>` +
      list(
        p.accrual.lines.map(
          (l) => `<li>${esc(l.provider)} ${esc(l.item)} · ${esc(l.costCenter)}: ${usd(l.amount)}</li>`,
        ),
      )
    : '<p class="muted">No accrual proposed.</p>'
}
<h2>Variance notes</h2>
${list(
  p.notes.map((x) => {
    const v = x.accepted ? x.versions.find((y) => y.version === x.accepted) : x.versions.at(-1);
    return `<li class="card"><b>${esc(x.name)}</b> · ${esc(x.status)}${v ? ` · v${v.version} (${esc(v.kind)}, ${esc(v.by)})` : ''}<br>${esc(v?.text ?? '')}${
      v?.decision
        ? `<br><span class="muted">${esc(v.decision.outcome)} by ${esc(v.decision.by)} ${esc(v.decision.at)}${v.decision.comment ? `: “${esc(v.decision.comment)}”` : ''}</span>`
        : ''
    }</li>`;
  }),
)}
<h2>Exceptions</h2>
${list(p.exceptions.map((e) => `<li>${esc(e.costCenter)}: actual ${usd(e.actual)}, budget ${usd(e.budget)}, uncovered ${usd(e.uncovered)}</li>`))}
<h2>Anomalies closed</h2>
${list(p.anomaliesClosed.map((a) => `<li>${esc(a.key)} (${esc(a.rule)}): ${esc(a.outcome)} ${esc(a.at)}</li>`))}
<h2>Decisions in the month</h2>
${list(p.decisions.map((d) => `<li>#${esc(d.number ?? '')} ${esc(d.title)}: step ${d.step} ${esc(d.outcome)} by ${esc(d.person)}, ${esc(d.at)}</li>`))}
<h2>Datarails</h2>
${list(p.uploads.map((u) => `<li>${u.ok ? 'Uploaded' : 'Failed'} (HTTP ${u.status}) by ${esc(u.uploadedBy)} ${esc(u.uploadedAt)}; snapshot <code>${esc(u.snapshotSha256)}</code></li>`))}
<h2>Chain proof</h2>
${kv([
  [
    'Chain',
    p.chain.ok ? `whole: ${p.chain.checked} entries checked` : `<b class="red">broken</b> (${p.chain.checked} checked)`,
  ],
  ['Head', `<code>${esc(p.chain.head ?? '')}</code>`],
  ['Lock entry', p.chain.lock ? `${p.chain.lock.seq} <code>${esc(p.chain.lock.hash)}</code>` : '—'],
  [
    'Anchor',
    p.chain.anchor
      ? `${p.chain.anchor.seq} <code>${esc(p.chain.anchor.hash)}</code> at ${esc(p.chain.anchor.at)}`
      : '—',
  ],
])}
<h2>Files</h2>
${list(p.files.map((x) => `<li>${esc(x.name)} (${x.rows} rows)<br><code>${esc(x.sha256)}</code></li>`))}
</body></html>
`;
}
