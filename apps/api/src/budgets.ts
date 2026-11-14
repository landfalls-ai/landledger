/**
 * Budgets (spec 003, wave 1): imported from a CSV of cost center, month, amount and currency; validated whole (a file
 * with a bad row imports nothing); versioned (each import is a version, append only); a month's budget for a cost
 * center is the newest import that names it. Datarails comes later (decision 4).
 */
import { SHARED_POOL } from '@landledger/allocation';
import type { BudgetImportView } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';

export interface BudgetRow {
  costCenter: string;
  month: string;
  amount: Money;
}

const HEADER = ['cost_center', 'month', 'amount', 'currency'];

/** Splits one CSV line (commas, double quotes, `""` inside quotes). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Parses and validates a budget CSV: a header `cost_center,month,amount,currency` (any case; `cost center` too), then
 * one row per cost center and month. Every problem is reported at once, with its line number.
 */
export function parseBudgetCsv(
  csv: string,
  costCenters: ReadonlySet<string>,
): { rows: BudgetRow[]; problems: string[] } {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const problems: string[] = [];
  const rows: BudgetRow[] = [];
  const head = cells(lines[0] ?? '').map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  if (HEADER.some((h, i) => head[i] !== h)) {
    return { rows, problems: [`Line 1: the header is ${HEADER.join(',')} (got ${head.join(',') || 'nothing'})`] };
  }
  const seen = new Set<string>();
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    if (!line.trim()) return;
    const [cc = '', month = '', amount = '', currency = ''] = cells(line);
    const code = cc.toUpperCase();
    if (!costCenters.has(code)) problems.push(`Line ${n}: cost center ${JSON.stringify(cc)} doesn't exist`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      problems.push(`Line ${n}: month ${JSON.stringify(month)} is not YYYY-MM`);
    if (currency.toUpperCase() !== REPORTING_CURRENCY)
      problems.push(
        `Line ${n}: currency ${JSON.stringify(currency)}: budgets are in ${REPORTING_CURRENCY} (FX comes later)`,
      );
    let money: Money | null = null;
    const clean = amount.replace(/[,\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(clean))
      problems.push(`Line ${n}: amount ${JSON.stringify(amount)} is not a non-negative number`);
    else {
      const d = Decimal.parse(clean);
      if (d.scale > 6) problems.push(`Line ${n}: amount ${amount} has more than six decimals`);
      else money = Money.fromDecimal(d, REPORTING_CURRENCY);
    }
    const key = `${code}|${month}`;
    if (seen.has(key)) problems.push(`Line ${n}: ${code} ${month} appears twice`);
    seen.add(key);
    if (money && costCenters.has(code)) rows.push({ costCenter: code, month, amount: money });
  });
  if (!rows.length && !problems.length) problems.push('The file has no rows');
  return { rows, problems };
}

export interface CurrentBudget {
  costCenter: string;
  amount: Money;
  importId: string;
  version: number;
}

export class Budgets {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  /** The codes a budget can name: every cost center, and the shared pool. */
  async codes(tx: Tx = this.sql): Promise<Set<string>> {
    const rows = await tx<{ code: string }[]>`SELECT DISTINCT code FROM cost_centers`;
    return new Set([...rows.map((r) => r.code), SHARED_POOL]);
  }

  /** Imports a CSV as the next budget version. People only (controller or CFO); the seed imports as `seed`. */
  async import(
    input: { csv: string; fileName?: string; note: string },
    by: Principal | { actor: 'seed' },
    origin: 'entered' | 'dev-seed' = 'entered',
  ) {
    if ('kind' in by) {
      if (by.kind !== 'person' && by.kind !== 'dev')
        throw new ApiError(
          'forbidden',
          'Budgets are imported by a person signed in with Landbright; an API key never does',
        );
      if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
        throw new ApiError('forbidden', 'Importing budgets is for the controller or the CFO');
    }
    const actor = 'kind' in by ? actorOf(by) : { actor: 'seed', actorKind: 'system' as const };
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('budgets'))`;
      const { rows, problems } = parseBudgetCsv(input.csv, await this.codes(tx));
      if (problems.length)
        throw new ApiError('bad_request', `The budget file has ${problems.length} problem(s); nothing was imported`, {
          problems,
        });
      const months = [...new Set(rows.map((r) => `${r.month}-01`))];
      const locked = await tx<{ month: Date }[]>`
        SELECT month FROM periods WHERE status = 'locked' AND month IN ${tx(months)} ORDER BY month`;
      if (locked.length)
        throw new ApiError(
          'conflict',
          `A locked month's budget is final: ${locked.map((l) => day(l.month).slice(0, 7)).join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked; nothing was imported`,
        );
      const checksum = sha256(input.csv);
      const [{ next }] = (await tx`SELECT coalesce(max(version), 0) + 1 AS next FROM budget_imports`) as unknown as [
        { next: number },
      ];
      const id = newId('bud');
      await tx`
        INSERT INTO budget_imports (id, version, source, file_name, note, origin, row_count, checksum, imported_by)
        VALUES (${id}, ${next}, 'csv', ${input.fileName ?? null}, ${input.note}, ${origin}, ${rows.length}, ${checksum}, ${actor.actor})`;
      await tx`INSERT INTO budgets ${tx(
        rows.map((r) => ({
          import_id: id,
          cost_center_code: r.costCenter,
          month: `${r.month}-01`,
          amount_micros: r.amount.micros.toString(),
          currency: r.amount.currency,
        })),
      )}`;
      await this.audit.append(
        {
          ...actor,
          action: 'budget.imported',
          subjectType: 'budget_import',
          subjectId: id,
          data: {
            version: Number(next),
            source: 'csv',
            fileName: input.fileName ?? null,
            rows: rows.length,
            checksum,
            origin,
          },
        },
        tx,
      );
      return { id, version: Number(next), rows: rows.length, checksum };
    }) as Promise<{ id: string; version: number; rows: number; checksum: string }>;
  }

  /** Each cost center's budget for a month: the newest import that names it. */
  async forMonth(month: string): Promise<Map<string, CurrentBudget>> {
    const rows = await this.sql<
      { cost_center_code: string; amount_micros: string; currency: string; import_id: string; version: number }[]
    >`
      SELECT DISTINCT ON (b.cost_center_code) b.cost_center_code, b.amount_micros, b.currency, b.import_id, i.version
      FROM budgets b JOIN budget_imports i ON i.id = b.import_id
      WHERE b.month = ${`${month}-01`}
      ORDER BY b.cost_center_code, i.version DESC`;
    return new Map(
      rows.map((r) => [
        r.cost_center_code,
        {
          costCenter: r.cost_center_code,
          amount: Money.ofMicros(r.amount_micros, r.currency.trim()),
          importId: r.import_id,
          version: r.version,
        },
      ]),
    );
  }

  /** The imports with these version numbers, newest first. */
  async imports(versions: readonly number[]): Promise<BudgetImportView[]> {
    if (!versions.length) return [];
    const rows = await this.sql<
      {
        version: number;
        source: string;
        file_name: string | null;
        note: string;
        origin: string;
        imported_by: string;
        imported_at: Date;
      }[]
    >`SELECT * FROM budget_imports WHERE version IN ${this.sql(versions as number[])} ORDER BY version DESC`;
    return rows.map((r) => ({
      version: r.version,
      source: r.source,
      fileName: r.file_name,
      importedAt: r.imported_at.toISOString(),
      importedBy: r.imported_by,
      origin: r.origin,
      note: r.note,
    }));
  }

  async latestImport() {
    const [r] = await this.sql<
      {
        id: string;
        version: number;
        source: string;
        file_name: string | null;
        note: string;
        origin: string;
        imported_by: string;
        imported_at: Date;
      }[]
    >`
      SELECT * FROM budget_imports ORDER BY version DESC LIMIT 1`;
    return r
      ? {
          version: r.version,
          source: r.source,
          fileName: r.file_name,
          importedAt: r.imported_at.toISOString(),
          importedBy: r.imported_by,
          origin: r.origin,
          note: r.note,
        }
      : null;
  }
}
