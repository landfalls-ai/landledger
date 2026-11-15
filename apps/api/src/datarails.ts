/**
 * The Datarails connector (wave 4, spec 017), built against fake-datarails on this machine. Two ways:
 *
 * - **Budgets in, as a pending change.** A controller or the CFO pulls a budget data model over MCP (read tools only:
 *   `list_data_models`, `list_aliased_fields`, `query_data_model`). The rows are kept as received with their sha256 and
 *   wait; a controller or the CFO accepts them (as a CSV budget import is accepted) into a new budget version, source
 *   `datarails`, or rejects them. Nothing changes a budget until a person accepts.
 * - **Actuals out, from the snapshot.** Step 9 of the close uploads the frozen snapshot's figures by cost center and
 *   the accepted variance notes to a FileBox (multipart, Basic auth). The upload is recorded with the snapshot's hash,
 *   each file's sha256 and what Datarails answered, whether it worked or not.
 *
 * A real tenant stays off: a host that isn't loopback is refused unless `LANDLEDGER_DATARAILS_REAL=true` (wave 5, the
 * user's decision).
 */
import type {
  DatarailsPullView,
  DatarailsStatus,
  DatarailsUploadedData,
  DatarailsUploadView,
} from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import type { Budgets } from './budgets.js';
import { canonicalJson } from './canonical.js';
import { type DatarailsConfig, isLoopbackUrl } from './config.js';
import { toCsv } from './export.js';
import { day as dayOf, type Sql } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import type { Notes } from './notes.js';
import { actorOf, type Principal } from './principal.js';
import type { Snapshots } from './snapshot.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;

export interface BudgetRowIn {
  costCenter: string;
  month: string;
  amount: string;
  currency: string;
}

/** Datarails rows keyed by field id, read through the aliases: cost_center, period, amount, currency. */
export function rowsByAlias(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: ReadonlyArray<{ id: string; alias: string }>,
): { rows: BudgetRowIn[]; problems: string[] } {
  const id = (alias: string) => fields.find((f) => f.alias === alias)?.id;
  const need = ['cost_center', 'period', 'amount'];
  const missing = need.filter((a) => !id(a));
  if (missing.length) return { rows: [], problems: [`The data model has no ${missing.join(', ')} field`] };
  const problems: string[] = [];
  const out: BudgetRowIn[] = [];
  rows.forEach((r, i) => {
    const cc = String(r[id('cost_center')!] ?? '')
      .trim()
      .toUpperCase();
    const month = String(r[id('period')!] ?? '')
      .trim()
      .slice(0, 7);
    const raw = r[id('amount')!];
    const amount = typeof raw === 'number' ? raw.toFixed(6) : String(raw ?? '').trim();
    const currency = id('currency')
      ? String(r[id('currency')!] ?? USD)
          .trim()
          .toUpperCase()
      : USD;
    if (!cc || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^\d+(\.\d+)?$/.test(amount))
      problems.push(`Row ${i + 1}: ${JSON.stringify(r)} is not a cost center, month and amount`);
    else out.push({ costCenter: cc, month, amount: Money.parse(amount, USD).toDecimal().toString(), currency });
  });
  return { rows: out, problems };
}

type PullRow = {
  id: string;
  data_model: string;
  rows: BudgetRowIn[];
  row_count: number;
  sha256: string;
  source_url: string;
  note: string;
  pulled_by: string;
  puller: string | null;
  pulled_at: Date;
  outcome: 'accepted' | 'rejected' | null;
  decider: string | null;
  decided_at: Date | null;
  reason: string | null;
  budget_version: number | null;
};
type UploadRow = {
  id: string;
  month: Date;
  snapshot_sha: string;
  files: DatarailsUploadView['files'];
  ok: boolean;
  status: number;
  response: Record<string, unknown>;
  uploader: string | null;
  uploaded_by: string;
  uploaded_at: Date;
};

/** The most rows one budget pull reads; a model with more is refused (narrow it by scenario). */
export const PULL_LIMIT = 5000;

export class Datarails {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly budgets: Budgets,
    private readonly snapshots: Snapshots,
    private readonly notes: Notes,
    private readonly period: (month: string) => Promise<{ status: string; reopened: boolean }>,
    private readonly config: DatarailsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get loopback() {
    return isLoopbackUrl(this.config.mcpUrl) && isLoopbackUrl(this.config.uploadUrl);
  }

  /** Refuses a host that isn't this machine unless a real tenant is turned on (wave 5). */
  private guard() {
    if (!this.loopback && !this.config.real)
      throw new ApiError(
        'unavailable',
        'Datarails points at a host that is not this machine: a real tenant is wave 5 and needs LANDLEDGER_DATARAILS_REAL=true',
      );
  }

  private person(by: Principal, what: string) {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', `A person signed in with Landbright ${what}; an API key never does`);
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', `The controller or the CFO ${what}`);
  }

  // MCP -----------------------------------------------------------------------------------------------------------------

  private rpcId = 0;

  private async rpc(
    method: string,
    params: Record<string, unknown> = {},
    session?: string,
  ): Promise<{ result: unknown; session?: string }> {
    if (!this.config.mcpToken) throw new ApiError('unavailable', 'LANDLEDGER_DATARAILS_MCP_TOKEN is not set');
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.mcpUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.mcpToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
        // Review of wave 4 (should-fix 9): a redirect is refused, never followed off the machine.
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ApiError('unavailable', `Datarails MCP did not answer: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ApiError('unavailable', `Datarails MCP answered HTTP ${res.status}`);
    const text = await res.text();
    // Streamable HTTP may answer as an event stream: the JSON-RPC message is the last `data:` line.
    const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .at(-1)!
            .slice(5),
        )
      : JSON.parse(text);
    if (json.error) throw new ApiError('unavailable', `Datarails MCP: ${json.error.message}`);
    return { result: json.result, session: res.headers.get('mcp-session-id') ?? session };
  }

  private async tool<T>(name: string, args: Record<string, unknown>, session?: string): Promise<T> {
    const { result } = await this.rpc('tools/call', { name, arguments: args }, session);
    const r = result as { structuredContent?: T; content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (r.isError) throw new ApiError('unavailable', `Datarails ${name}: ${r.content?.[0]?.text ?? 'failed'}`);
    return r.structuredContent ?? (JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? 'null') as T);
  }

  // Budgets in ---------------------------------------------------------------------------------------------------------

  async pull(input: { dataModel: string; scenario?: string; note: string }, by: Principal): Promise<DatarailsPullView> {
    this.person(by, 'pulls a budget from Datarails');
    this.guard();
    const { session } = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'landledger', version: '0.4.0' },
    });
    const { data_models } = await this.tool<{ data_models: Array<{ id: string; name: string }> }>(
      'list_data_models',
      {},
      session,
    );
    const model = data_models.find((m) => m.id === input.dataModel || m.name === input.dataModel);
    if (!model) throw new ApiError('bad_request', `Datarails has no data model ${JSON.stringify(input.dataModel)}`);
    const { fields } = await this.tool<{ fields: Array<{ id: string; alias: string }> }>(
      'list_aliased_fields',
      { data_model_id: model.id },
      session,
    );
    const q = await this.tool<{ rows: Array<Record<string, unknown>>; total?: number }>(
      'query_data_model',
      {
        data_model_id: model.id,
        ...(input.scenario ? { filters: { scenario: input.scenario } } : {}),
        limit: PULL_LIMIT,
      },
      session,
    );
    // Review of wave 4, nit: a pull that hit the limit is refused, never kept cut short.
    if ((typeof q.total === 'number' && q.total > q.rows.length) || q.rows.length >= PULL_LIMIT)
      throw new ApiError(
        'unprocessable',
        `${model.name} returned ${q.rows.length} of ${q.total ?? 'more'} rows: name a scenario to narrow it; nothing was kept`,
        { returned: q.rows.length, total: q.total ?? null },
      );
    const { rows, problems } = rowsByAlias(q.rows, fields);
    if (problems.length)
      throw new ApiError('unprocessable', `Datarails' rows have ${problems.length} problem(s); nothing was kept`, {
        problems: problems.slice(0, 20),
      });
    if (!rows.length)
      throw new ApiError('unprocessable', `${model.name} has no rows${input.scenario ? ` for ${input.scenario}` : ''}`);
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.costCenter}|${r.month}`;
      if (seen.has(k))
        throw new ApiError('unprocessable', `${model.name} has ${r.costCenter} ${r.month} twice: name a scenario`, {
          key: k,
        });
      seen.add(k);
    }
    // The rows as received, in Datarails' order (amounts may be JSON numbers, so not canonical JSON).
    const hash = sha256(JSON.stringify(q.rows));
    const id = newId('drp');
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO datarails_pulls (id, data_model, rows, row_count, sha256, source_url, note, pulled_by)
        VALUES (${id}, ${`${model.name}${input.scenario ? ` · ${input.scenario}` : ''}`}, ${tx.json(rows as never)},
                ${rows.length}, ${hash}, ${this.config.mcpUrl}, ${input.note}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'datarails.budget_pulled',
          subjectType: 'datarails_pull',
          subjectId: id,
          data: {
            dataModel: model.id,
            scenario: input.scenario ?? null,
            rows: rows.length,
            sha256: hash,
            from: this.config.mcpUrl,
          },
        },
        tx,
      );
    });
    return this.pullView(id);
  }

  private async pullRow(id: string): Promise<PullRow> {
    const [p] = await this.sql<PullRow[]>`
      SELECT p.*, pu.email AS puller, d.outcome, du.email AS decider, d.decided_at, d.reason, b.version AS budget_version
      FROM datarails_pulls p
      LEFT JOIN users pu ON pu.id = p.pulled_by
      LEFT JOIN datarails_pull_decisions d ON d.pull_id = p.id
      LEFT JOIN users du ON du.id = d.decided_by
      LEFT JOIN budget_imports b ON b.id = d.budget_import_id
      WHERE p.id = ${id}`;
    if (!p) throw notFound('Datarails pull');
    return p;
  }

  async pullView(id: string): Promise<DatarailsPullView> {
    const p = await this.pullRow(id);
    const months = [...new Set(p.rows.map((r) => r.month))].sort();
    const current = new Map<string, Map<string, string>>();
    for (const m of months)
      current.set(
        m,
        new Map(
          [...(await this.budgets.forMonth(m))].map(([cc, b]) => [cc, b.amount.toDecimal().toFixed(6, 'halfEven')]),
        ),
      );
    return {
      id: p.id,
      status: p.outcome ?? 'pending',
      dataModel: p.data_model,
      rows: p.row_count,
      months,
      total: Money.sum(
        p.rows.map((r) => Money.parse(r.amount, USD)),
        USD,
      )
        .toDecimal()
        .toFixed(6, 'halfEven'),
      sha256: p.sha256,
      pulledBy: p.puller ?? p.pulled_by,
      pulledAt: p.pulled_at.toISOString(),
      decidedBy: p.decider,
      decidedAt: p.decided_at?.toISOString() ?? null,
      budgetVersion: p.budget_version,
      reason: p.reason,
      preview: p.rows.map((r) => ({
        costCenter: r.costCenter,
        month: r.month,
        amount: Money.parse(r.amount, USD).toDecimal().toFixed(6, 'halfEven'),
        current: current.get(r.month)?.get(r.costCenter) ?? null,
      })),
    };
  }

  /** Accepted as a CSV import is: a new budget version, source `datarails`, in the decision's transaction. */
  async accept(id: string, input: { sha256: string; note: string }, by: Principal): Promise<DatarailsPullView> {
    this.person(by, 'accepts a Datarails budget');
    const p = await this.pullRow(id);
    if (p.outcome) throw new ApiError('conflict', `This pull is ${p.outcome} already`);
    if (p.sha256 !== input.sha256) throw new ApiError('conflict', 'The pull shown is not this one; reopen it');
    const csv = toCsv({
      name: 'budget',
      header: ['cost_center', 'month', 'amount', 'currency'],
      rows: p.rows.map((r) => [r.costCenter, r.month, r.amount, r.currency]),
    });
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`datarails:${id}`}))`;
      const [d] = await tx`SELECT 1 FROM datarails_pull_decisions WHERE pull_id = ${id}`;
      if (d) throw new ApiError('conflict', 'This pull was decided already');
      const imp = await this.budgets.import(
        {
          csv,
          fileName: `datarails-${p.id}.csv`,
          note: input.note || `Datarails ${p.data_model} (${p.sha256.slice(0, 12)}…)`,
        },
        by,
        'entered',
        { source: 'datarails', tx },
      );
      await tx`
        INSERT INTO datarails_pull_decisions (pull_id, outcome, decided_by, reason, budget_import_id)
        VALUES (${id}, 'accepted', ${by.id}, ${input.note}, ${imp.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'datarails.budget_accepted',
          subjectType: 'datarails_pull',
          subjectId: id,
          data: { sha256: p.sha256, budgetVersion: imp.version, rows: imp.rows },
        },
        tx,
      );
    });
    return this.pullView(id);
  }

  async reject(id: string, reason: string, by: Principal): Promise<DatarailsPullView> {
    this.person(by, 'rejects a Datarails budget');
    const p = await this.pullRow(id);
    if (p.outcome) throw new ApiError('conflict', `This pull is ${p.outcome} already`);
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO datarails_pull_decisions (pull_id, outcome, decided_by, reason)
        VALUES (${id}, 'rejected', ${by.id}, ${reason})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'datarails.budget_rejected',
          subjectType: 'datarails_pull',
          subjectId: id,
          data: { sha256: p.sha256, reason },
        },
        tx,
      );
    });
    return this.pullView(id);
  }

  // Actuals out ----------------------------------------------------------------------------------------------------------

  /** The files step 9 uploads: actuals by cost center from the snapshot, the accepted notes, the snapshot itself. */
  async files(month: string): Promise<{
    snapshotId: string;
    snapshotSha256: string;
    files: Array<{ name: string; body: string; rows: number }>;
  }> {
    const s = await this.snapshots.latest(month);
    if (!s) throw new ApiError('conflict', `${month} has no snapshot: the accrual (step 7) freezes it`);
    const f = s.figures;
    const accrualBy = new Map<string, Money>();
    const prepaidBy = new Map<string, Money>();
    if (f.accrual) {
      const lines = await this.sql<{ cost_center: string; amount_micros: string; kind: string }[]>`
        SELECT cost_center, amount_micros, kind FROM accrual_lines WHERE accrual_id = ${f.accrual.id}`;
      for (const l of lines) {
        const into = l.kind === 'prepaid' ? prepaidBy : accrualBy;
        into.set(
          l.cost_center,
          (into.get(l.cost_center) ?? Money.zero(USD)).plus(Money.ofMicros(l.amount_micros, USD)),
        );
      }
    }
    // Review of wave 4 (should-fix 13): one figure to book per cost center, `total_excl_notional` (invoiced and
    // estimated). The rest are memos a mapping must never add: the notional cluster cost is never booked, the accrual is
    // the estimated part again (as the journal books it) and the prepaid amortisation is an asset's expense.
    const actuals = [
      [
        'cost_center',
        'cost_center_name',
        'period',
        'invoiced',
        'estimated',
        'total_excl_notional',
        'memo_notional_not_booked',
        'memo_accrual_in_total',
        'memo_prepaid_amortised',
        'budget',
        'currency',
        'snapshot_sha256',
      ],
      ...f.byCostCenter.map((c) => [
        c.code,
        c.name,
        month,
        Money.parse(c.invoiced, USD).toCsv(),
        Money.parse(c.estimated, USD).toCsv(),
        Money.parse(c.estimated, USD).plus(Money.parse(c.invoiced, USD)).toCsv(),
        Money.parse(c.notional, USD).toCsv(),
        (accrualBy.get(c.code) ?? Money.zero(USD)).toCsv(),
        (prepaidBy.get(c.code) ?? Money.zero(USD)).toCsv(),
        c.budget === null ? '' : Money.parse(c.budget, USD).toCsv(),
        USD,
        s.sha256,
      ]),
    ];
    const notes = await this.notes.list(month);
    const noteRows = [
      ['cost_center', 'period', 'version', 'accepted_by', 'accepted_at', 'snapshot_sha256', 'text'],
      ...notes.notes
        .filter((n) => n.current && n.status === 'accepted')
        .map((n) => {
          const v = n.versions.find((x) => x.version === n.accepted)!;
          return [n.costCenter, month, String(v.version), v.decision!.by, v.decision!.at, v.snapshotSha256, v.text];
        }),
    ];
    const snapshotJson = canonicalJson(f);
    return {
      snapshotId: s.id,
      snapshotSha256: s.sha256,
      files: [
        {
          name: `landledger-actuals-${month}.csv`,
          body: toCsv({ name: 'actuals', header: actuals[0]!, rows: actuals.slice(1) }),
          rows: actuals.length - 1,
        },
        {
          name: `landledger-notes-${month}.csv`,
          body: toCsv({ name: 'notes', header: noteRows[0]!, rows: noteRows.slice(1) }),
          rows: noteRows.length - 1,
        },
        { name: `landledger-snapshot-${month}.json`, body: snapshotJson, rows: 1 },
      ],
    };
  }

  async upload(month: string, by: Principal): Promise<DatarailsUploadView> {
    this.person(by, 'uploads to Datarails');
    this.guard();
    const p = await this.period(month);
    if (p.status === 'open') throw new ApiError('conflict', `${month}'s close hasn't started`);
    if (p.status === 'locked' && !p.reopened) throw new ApiError('conflict', `${month} is locked: its upload is done`);
    const s = await this.snapshots.latest(month);
    if (!s) throw new ApiError('conflict', `${month} has no snapshot: the accrual (step 7) freezes it`);
    if (!(await this.snapshots.isCurrent(s)))
      throw new ApiError(
        'conflict',
        `${month}'s figures moved since the snapshot: the accrual is proposed again first`,
      );
    const g = await this.notes.gate(month);
    if (g.missing.length)
      throw new ApiError('conflict', `Accept every variance note first (step 8): ${g.missing.join(', ')} still open`);
    if (!this.config.user || !this.config.password)
      throw new ApiError('unavailable', 'LANDLEDGER_DATARAILS_USER and LANDLEDGER_DATARAILS_PASSWORD are not set');
    const { files } = await this.files(month);
    const form = new FormData();
    form.set('filebox_id', this.config.filebox);
    for (const f of files)
      form.append(
        'file',
        new Blob([f.body], { type: f.name.endsWith('.json') ? 'application/json' : 'text/csv' }),
        f.name,
      );
    let status = 0;
    let response: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(this.config.uploadUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64')}`,
        },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      const text = await res.text();
      try {
        response = JSON.parse(text) as Record<string, unknown>;
      } catch {
        response = { body: text.slice(0, 2000) };
      }
    } catch (e) {
      response = { error: (e as Error).message };
    }
    const ok = status >= 200 && status < 300;
    const fileRows = files.map((f) => ({
      name: f.name,
      sha256: sha256(f.body),
      rows: f.rows,
      bytes: Buffer.byteLength(f.body),
    }));
    const id = newId('dru');
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO datarails_uploads (id, month, snapshot_id, snapshot_sha, files, ok, status, response, target_url, uploaded_by)
        VALUES (${id}, ${`${month}-01`}, ${s.id}, ${s.sha256}, ${tx.json(fileRows as never)}, ${ok}, ${status},
                ${tx.json(response as never)}, ${this.config.uploadUrl}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: ok ? 'datarails.uploaded' : 'datarails.upload_failed',
          subjectType: 'period',
          subjectId: month,
          data: {
            uploadId: id,
            snapshotSha256: s.sha256,
            status,
            files: fileRows.map((f) => ({ name: f.name, sha256: f.sha256 })),
            to: this.config.uploadUrl,
          },
        },
        tx,
      );
      const data: DatarailsUploadedData = {
        month,
        uploadId: id,
        snapshotSha256: s.sha256,
        ok,
        files: fileRows.map((f) => ({ name: f.name, sha256: f.sha256 })),
      };
      await this.webhooks.enqueue(tx, 'datarails.uploaded', data as never);
    });
    const view = (await this.uploads(month)).find((u) => u.id === id)!;
    if (!ok)
      throw new ApiError('unavailable', `Datarails refused the upload (HTTP ${status || 'none'}); it is recorded`, {
        upload: view,
      });
    return view;
  }

  async uploads(month?: string): Promise<DatarailsUploadView[]> {
    const rows = await this.sql<UploadRow[]>`
      SELECT d.*, u.email AS uploader FROM datarails_uploads d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE ${month ?? null}::text IS NULL OR d.month = ${month ? `${month}-01` : '1970-01-01'}::date
      ORDER BY d.uploaded_at DESC LIMIT 100`;
    return rows.map((u) => ({
      id: u.id,
      month: dayOf(u.month).slice(0, 7),
      snapshotSha256: u.snapshot_sha,
      files: u.files,
      ok: u.ok,
      status: u.status,
      response: u.response,
      uploadedBy: u.uploader ?? u.uploaded_by,
      uploadedAt: u.uploaded_at.toISOString(),
    }));
  }

  async status(): Promise<DatarailsStatus> {
    const pulls = await this.sql<{ id: string }[]>`SELECT id FROM datarails_pulls ORDER BY pulled_at DESC LIMIT 50`;
    return {
      mcpUrl: this.config.mcpUrl,
      uploadUrl: this.config.uploadUrl,
      filebox: this.config.filebox,
      loopback: this.loopback,
      real: this.config.real,
      configured: !!(this.config.mcpToken && this.config.user && this.config.password),
      pulls: await Promise.all(pulls.map((p) => this.pullView(p.id))),
      uploads: await this.uploads(),
    };
  }
}
