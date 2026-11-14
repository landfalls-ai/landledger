/**
 * Wave 1's read API (specs 002 and 003, docs/ui.md): ingest runs, spend grouped by any dimension, the Overview's
 * figures and Budgets. Amounts are decimal strings in major units with six decimals (`"12.345678"`) in the response's
 * one `currency`; nothing is a JSON number.
 */
import { z } from 'zod';

const Day = z.iso.date();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM');

/** An amount in major units, exact to the micro-unit, as a string. */
export type Amount = string;

// Ingest --------------------------------------------------------------------------------------------------------------

export interface IngestRun {
  id: string;
  source: 'landflow' | 'clickland' | 'invoice' | 'manual';
  kind: 'hourly' | 'daily' | 'backfill' | 'manual';
  day: string;
  rateCardVersionId: string | null;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed';
  readCount: number;
  newCount: number;
  correctedCount: number;
  unchangedCount: number;
  warnings: string[];
  error: string | null;
  observedFrom: string | null;
  observedTo: string | null;
}

export const IngestRunsQuery = z.object({
  source: z.enum(['landflow', 'clickland']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const IngestRunInput = z
  .object({
    source: z.enum(['landflow', 'clickland', 'all']).default('all'),
    /** A UTC day; today goes to the provisional table. Default: today. */
    day: Day.optional(),
    /**
     * When the source answers with nothing for a day the ledger has entries for, the run is refused rather than reverse
     * the day; `force` with a reason reverses it (audited `ingest.forced`).
     */
    force: z.boolean().default(false),
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .refine((v) => !v.force || v.reason, {
    message: 'A forced run needs a reason (10 characters or more)',
    path: ['reason'],
  });

/** Locking a month that fails its checks: a controller, with a reason; audited. */
export const LockInput = z
  .object({ override: z.object({ reason: z.string().trim().min(10).max(1000) }).optional() })
  .default({});
export type LockInput = z.infer<typeof LockInput>;
export type IngestRunInput = z.infer<typeof IngestRunInput>;

// Spend ---------------------------------------------------------------------------------------------------------------

/** What Explore groups and filters by (docs/ui.md). */
export const Dimension = z.enum([
  'costCenter',
  'team',
  'product',
  'service',
  'namespace',
  'agent',
  'model',
  'provider',
  'plClass',
  'category',
  'resource',
  'workflow',
]);
export type Dimension = z.infer<typeof Dimension>;

export const DIMENSION_LABEL: Readonly<Record<Dimension, string>> = {
  costCenter: 'Cost center',
  team: 'Team',
  product: 'Product',
  service: 'Service',
  namespace: 'Namespace',
  agent: 'Agent',
  model: 'Model',
  provider: 'Provider',
  plClass: 'P&L class',
  category: 'Category',
  resource: 'Resource',
  workflow: 'Workflow',
};

/** Where a row of Explore drills to (cost center → service → resource), as the prototype does. */
export const DRILL: Readonly<Partial<Record<Dimension, Dimension>>> = {
  costCenter: 'service',
  team: 'service',
  product: 'service',
  service: 'resource',
  namespace: 'service',
  agent: 'model',
  model: 'agent',
  provider: 'service',
  plClass: 'costCenter',
  category: 'service',
  workflow: 'model',
};

/** Spend for a window: `month` (YYYY-MM), or `from` and `to` (UTC days, `to` inclusive). */
export const SpendQuery = z.object({
  month: Month.optional(),
  from: Day.optional(),
  to: Day.optional(),
  by: Dimension.default('costCenter'),
  /** Filters as `dimension:value`, repeated or comma-joined (`costCenter:ENG-PLATFORM,service:landflow-host`). */
  filter: z.union([z.string(), z.array(z.string())]).optional(),
  /** `direct` (the books' view; the shared pool on its own) or `spread` (the shared pool shared out by the rules). */
  layer: z.enum(['direct', 'spread']).default('direct'),
  /** Include today's provisional figures (default yes). */
  provisional: z.enum(['true', 'false']).default('true'),
});
export type SpendQuery = z.infer<typeof SpendQuery>;

export interface SpendGroup {
  key: string;
  label: string;
  /** A second line: a cost center's name, a workload's namespace. */
  sub: string | null;
  estimated: Amount;
  invoiced: Amount;
  total: Amount;
  /** The same group over the window before (same length); null when there is no data then. */
  previous: Amount | null;
  /** Share of the total, percent with one decimal. */
  share: string;
  /** Today's provisional part of `total`. */
  provisional: Amount;
  /** Clickland's service page, for a service that has one. */
  clicklandUrl: string | null;
}

export interface SpendResult {
  from: string;
  to: string;
  /**
   * `billing`: a month's view, every record booked in the month (its billing period), so a locked month never changes;
   * a correction to a locked month is its own line (`CORRECTIONS`). `charge`: a range of days (`from`/`to`), records by
   * the day they were charged, wherever they were booked.
   */
  basis: 'billing' | 'charge';
  by: Dimension;
  layer: 'direct' | 'spread';
  filters: { dimension: Dimension; value: string }[];
  currency: string;
  total: {
    estimated: Amount;
    invoiced: Amount;
    total: Amount;
    provisional: Amount;
    previous: Amount | null;
    /** Corrections to locked months booked in this month (part of `total`; zero for a range of days). */
    corrections: Amount;
  };
  groups: SpendGroup[];
  /** Daily totals for the top groups and the rest (`other`), for the stacked bar. */
  daily: { days: string[]; series: { key: string; label: string; values: Amount[] }[] };
  /** Across the whole window, before filters: the 80% measure. */
  attribution: { direct: Amount; sharedPool: Amount; unallocated: Amount; total: Amount; directShare: string };
  /** The drill-down dimension for a row of this grouping, if any. */
  drill: Dimension | null;
  warnings: string[];
}

// Overview ------------------------------------------------------------------------------------------------------------

/**
 * `over`: actual above budget; `risk`: the forecast is; `ok`: neither; `none`: no budget; `early`: not over, and too
 * little data for a forecast (fewer than three full observed days of a source), so no state is claimed.
 */
export type BudgetState = 'ok' | 'risk' | 'over' | 'none' | 'early';

/** The line a month's corrections to locked months are reported on, in every breakdown (never in a cost center). */
export const CORRECTIONS = 'CORRECTIONS';

export interface CostCenterLine {
  code: string;
  name: string;
  owner: string | null;
  monthToDate: Amount;
  invoiced: Amount;
  budget: Amount | null;
  /** Null when there is not enough data for a forecast (see `Overview.forecast.status`). */
  forecast: Amount | null;
  /** Wave 2: approved requests' reservations. Zero until then. */
  reserved: Amount;
  state: BudgetState;
}

export interface Overview {
  month: string;
  today: string;
  dayOfMonth: number;
  daysInMonth: number;
  currency: string;
  monthToDate: { total: Amount; estimated: Amount; invoiced: Amount; provisional: Amount; corrections: Amount };
  forecast: {
    /**
     * `ok`: every source has at least three full observed days in the last seven; `insufficient`: one doesn't (no
     * forecast, no range, no state); `past`: a past month, actuals only.
     */
    status: 'ok' | 'insufficient' | 'past';
    amount: Amount | null;
    low: Amount | null;
    high: Amount | null;
    /** How the run rate was taken, in words. */
    basis: string;
    /** Cost per day at the run rate (low, mid, high). */
    perDay: { low: Amount; mid: Amount; high: Amount } | null;
    /** The newest of the sources' first observed moments: the figures rest on data since then. */
    dataSince: string | null;
    /** How much of the month the figures observe, percent with one decimal (from `dataSince` or the 1st, to now). */
    observedShare: string;
    /** Per source: since when, full observed days and hours in the last seven days, and its cost per hour. */
    sources: {
      source: string;
      since: string | null;
      fullDays: number;
      observedHours: string;
      perHour: Amount | null;
    }[];
  };
  budget: {
    amount: Amount | null;
    /** The budget imports the month's figures come from (one cost center can come from a later import). */
    versions: number[];
    source: string | null;
    importedAt: string | null;
    /** `dev-seed` when any of them is development seed data. */
    origin: string | null;
  };
  /** Budget − actuals − reservations (no reservations until wave 2). */
  leftAfterReservations: Amount | null;
  reserved: Amount;
  burn: { day: string; actual: Amount | null; forecast: Amount | null; low: Amount | null; high: Amount | null }[];
  costCenters: CostCenterLine[];
  byCategory: { key: string; label: string; amount: Amount; invoiced: Amount }[];
  byPlClass: { key: string; label: string; amount: Amount; invoiced: Amount }[];
  attribution: SpendResult['attribution'];
  runs: { source: string; day: string; finishedAt: string | null; outcome: string; warnings: string[] }[];
  rateCard: { version: number | null; status: 'approved' | 'proposed' | 'none'; approvedBy: string | null };
}

export const MonthQuery = z.object({ month: Month.optional() });

// Budgets -------------------------------------------------------------------------------------------------------------

export interface BudgetLine extends CostCenterLine {
  available: Amount | null;
  variance: Amount | null;
  /** Variance ÷ budget, percent with one decimal. */
  variancePct: string | null;
  /** The last months: budget and actual. */
  months: { month: string; budget: Amount | null; actual: Amount; locked: boolean }[];
}

export interface BudgetImportView {
  version: number;
  source: string;
  fileName: string | null;
  importedAt: string;
  importedBy: string;
  origin: string;
  note: string;
}

export interface BudgetsView {
  month: string;
  currency: string;
  /** The imports the month's budgets come from, newest first (each cost center's newest import that names it). */
  versions: BudgetImportView[];
  rows: BudgetLine[];
  totals: {
    budget: Amount;
    actual: Amount;
    reserved: Amount;
    available: Amount;
    forecast: Amount | null;
    variance: Amount | null;
    variancePct: string | null;
    state: BudgetState;
  };
}

export const BudgetImportInput = z.object({
  csv: z.string().min(1).max(1_000_000),
  fileName: z.string().max(200).optional(),
  note: z.string().max(500).default(''),
});
export type BudgetImportInput = z.infer<typeof BudgetImportInput>;

// Rule sets -----------------------------------------------------------------------------------------------------------

export interface RuleSetVersionView {
  id: string;
  ruleSetId: string;
  version: number;
  status: 'proposed' | 'approved';
  effectiveFrom: string;
  effectiveTo: string | null;
  rules: unknown[];
  shares: unknown[];
  note: string;
  origin: string;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}
