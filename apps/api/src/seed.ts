/**
 * `pnpm db:seed`: what a fresh local Landledger needs, idempotent (a second run adds nothing).
 *
 * - Rate card v1's cluster lines from docs/plan.md decision 3, as a **proposal** (spec 002: a person approves it):
 *   USD 0.034 per core-hour, 0.0045 per GiB-hour of memory, 0.10 per GB-month of storage (730 hours a month), 0.02
 *   per GB of egress (not applied while network is unpriced), effective 1 Nov 2026. The AI lines come from Landflow's
 *   price table when spec 002's script imports them.
 * - DEVELOPMENT SEED DATA: the six cost centers of the prototype's sample data (ui/prototype.html), with its fictional
 *   owners, marked `origin = 'dev-seed'`. Real cost centers come from finance (CSV, Datarails or SCIM owners).
 *
 * - DEVELOPMENT SEED DATA: allocation rule set v1 (spec 003), mapping this machine's namespaces, workloads, compose
 *   projects and Landflow's AI usage to those cost centers, as a **proposal** (a person approves it).
 *
 * - DEVELOPMENT SEED DATA: November 2026's budgets from `seed/budgets-2026-11.dev.csv` (budget v1, origin `dev-seed`).
 *
 * Every row it adds is in the audit log, by actor `seed`: the system user of that name (migration 0005), so its
 * proposals have a proposer that is never a person and never approves.
 */
import { Rate } from '@landledger/money';
import { loadWorkspaceEnv, postgresUrlFromEnv } from '@landledger/schema';
import { Allocation } from './allocation.js';
import { AuditLog } from './audit.js';
import { Budgets } from './budgets.js';
import { readFileSync } from 'node:fs';
import { createSql, type Sql } from './db.js';
import { sha256 } from './ids.js';

export const RATE_CARD_ID = 'rc_internal';
export const RATE_CARD_V1 = 'rcv_internal_1';
const SEED = { actor: 'seed', actorKind: 'system' as const };

/** FOCUS units (Unit Format) and SKU names per docs/research/focus.md §3. */
export const RATE_CARD_V1_LINES = [
  {
    key: 'cpu',
    sku: 'landledger:k8s:cpu',
    meter: 'Allocated Cores',
    label: 'Compute',
    unit: 'Core-Hours',
    price: '0.034',
  },
  {
    key: 'memory',
    sku: 'landledger:k8s:memory',
    meter: 'Allocated Memory',
    label: 'Memory',
    unit: 'GiB-Hours',
    price: '0.0045',
  },
  {
    key: 'storage',
    sku: 'landledger:k8s:storage',
    meter: 'Storage',
    label: 'Storage',
    unit: 'GB-Months',
    price: '0.10',
  },
  {
    key: 'egress',
    sku: 'landledger:network:egress',
    meter: 'Egress',
    label: 'Network egress',
    unit: 'GB',
    price: '0.02',
    details: { Applied: false, Reason: 'Network is unpriced until finance decides what counts as egress' },
  },
] as const;

/** Development seed data: the prototype's sample cost centers and their fictional owners. */
export const DEV_COST_CENTERS = [
  {
    code: 'ENG-PLATFORM',
    name: 'Platform',
    owner: 'Dana Levi',
    description: 'Landflow, the cluster and shared platform services',
  },
  { code: 'ENG-AGENTS', name: 'AI Agents', owner: 'Omer Katz', description: 'The agents and their models' },
  { code: 'ENG-PRODUCT', name: 'Product Engineering', owner: 'Maya Cohen', description: 'The web and mobile apps' },
  {
    code: 'RND-DATA',
    name: 'Data & ML',
    owner: 'Yael Ben-David',
    description: 'ClickHouse, model evaluations and data jobs',
  },
  { code: 'GA-IT', name: 'Internal IT', owner: 'Noam Peretz', description: 'Workplace tools and identity' },
  { code: 'CS-SUPPORT', name: 'Customer Support', owner: 'Lior Azulay', description: 'The support desk and its tools' },
] as const;

/**
 * DEVELOPMENT SEED DATA: budgets for November 2026, picked against this machine's real costs once Docker stopped being
 * counted twice (14 Nov 2026, about USD 0.68 an hour, 16 a day, four fifths of it the cluster's idle capacity in the
 * shared pool): each cost center's month projected from its first five observed hours, with room to spare for most;
 * Platform and Data & ML a little under their projection, so they show at risk once the forecast has three full days.
 * Not anyone's real budget. The seed imports this file again (as a new budget version) whenever its contents change.
 */
export const DEV_BUDGETS_CSV = new URL('../seed/budgets-2026-11.dev.csv', import.meta.url);
export const DEV_BUDGETS_NOTE =
  "DEVELOPMENT SEED DATA: picked against this machine's real costs (about USD 16 a day, mostly the shared pool's idle capacity); not a real budget.";

export async function seed(sql: Sql, log: (line: string) => void = () => {}): Promise<number> {
  const audit = new AuditLog(sql);
  let added = 0;
  await sql.begin(async (tx) => {
    const card = await tx`
      INSERT INTO rate_cards (id, name, currency, owner)
      VALUES (${RATE_CARD_ID}, 'Internal rate card', 'USD', 'Finance')
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (card.length) {
      added++;
      await audit.append(
        {
          ...SEED,
          action: 'rate_card.created',
          subjectType: 'rate_card',
          subjectId: RATE_CARD_ID,
          data: { currency: 'USD' },
        },
        tx,
      );
    }
    const version = await tx`
      INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, hours_per_month, note, proposed_by)
      VALUES (${RATE_CARD_V1}, ${RATE_CARD_ID}, 1, '2026-11-01', 730,
              'Rate card v1: the cluster rates of decision 3 (docs/plan.md, 14 Nov 2026). AI lines are imported from Landflow''s list prices (spec 002).',
              'seed')
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (version.length) {
      added++;
      let position = 0;
      for (const l of RATE_CARD_V1_LINES) {
        Rate.of(l.price, 'USD', l.unit); // exact, non-negative, a FOCUS unit, or this throws
        await tx`
          INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, pricing_unit, unit_price,
                                  currency, details, position, added_by)
          VALUES (${`rl_internal_1_${l.key}`}, ${RATE_CARD_V1}, ${l.sku}, ${l.sku}, ${l.meter}, ${l.label}, ${l.unit},
                  ${l.price}::numeric, 'USD', ${'details' in l ? tx.json(l.details) : null}, ${position++}, 'seed')`;
      }
      await audit.append(
        {
          ...SEED,
          action: 'rate_card.version_proposed',
          subjectType: 'rate_card_version',
          subjectId: RATE_CARD_V1,
          data: {
            version: 1,
            effectiveFrom: '2026-11-01',
            lines: RATE_CARD_V1_LINES.map((l) => ({ sku: l.sku, unit: l.unit, price: l.price, currency: 'USD' })),
          },
        },
        tx,
      );
    }
    for (const c of DEV_COST_CENTERS) {
      const row = await tx`
        INSERT INTO cost_centers (code, version, name, description, owner_name, valid_from, origin, created_by)
        VALUES (${c.code}, 1, ${c.name}, ${c.description}, ${c.owner}, '2026-11-01', 'dev-seed', 'seed')
        ON CONFLICT (code, version) DO NOTHING RETURNING code`;
      if (row.length) {
        added++;
        await audit.append(
          {
            ...SEED,
            action: 'cost_center.created',
            subjectType: 'cost_center',
            subjectId: c.code,
            data: { version: 1, name: c.name, owner: c.owner, origin: 'dev-seed' },
          },
          tx,
        );
      }
    }
    // DEVELOPMENT SEED DATA: allocation rule set v1 (spec 003) as a proposal; a person approves it.
    added += await new Allocation(sql, audit).seedDevRules(tx);
  });
  // DEVELOPMENT SEED DATA: November 2026's budgets (seed/budgets-2026-11.dev.csv), imported when this version of the
  // file hasn't been (a changed file is a new budget version; the old one stays in the history).
  const csv = readFileSync(DEV_BUDGETS_CSV, 'utf8');
  const [{ n }] =
    (await sql`SELECT count(*)::int AS n FROM budget_imports WHERE checksum = ${sha256(csv)}`) as unknown as [
      { n: number },
    ];
  if (n === 0) {
    await new Budgets(sql, audit).import(
      { csv, fileName: 'budgets-2026-11.dev.csv', note: DEV_BUDGETS_NOTE },
      { actor: 'seed' },
      'dev-seed',
    );
    added++;
  }
  log(`seed: ${added} rows added${added ? '' : ' (already seeded)'}`);
  return added;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadWorkspaceEnv();
  const sql = createSql(postgresUrlFromEnv());
  try {
    await seed(sql, console.log);
  } finally {
    await sql.end();
  }
}
