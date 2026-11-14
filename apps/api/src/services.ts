import { AuditLog } from './audit.js';
import { Sessions } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { Dimensions } from './dimensions.js';
import { Keys } from './keys.js';
import { Periods, Records } from './ledger.js';
import { OidcClient } from './oidc.js';
import { Webhooks } from './webhooks.js';
import { Allocation } from './allocation.js';
import { Budgets } from './budgets.js';
import { Ingest, type IngestLog } from './ingest/runner.js';
import { ClicklandClient, LandflowClient } from './ingest/sources.js';
import { emitCostMetrics } from './metrics.js';
import { RateCards } from './ratecards.js';
import { Spend } from './spend.js';

/** Everything the routes call. */
export interface Services {
  config: Config;
  sql: Sql;
  audit: AuditLog;
  keys: Keys;
  sessions: Sessions;
  dimensions: Dimensions;
  webhooks: Webhooks;
  periods: Periods;
  records: Records;
  rateCards: RateCards;
  allocation: Allocation;
  budgets: Budgets;
  spend: Spend;
  ingest: Ingest;
  landflow: LandflowClient | null;
  log: IngestLog;
  fetchImpl: typeof fetch;
}

const SILENT: IngestLog = { info() {}, warn() {}, error() {} };

export function createServices(
  config: Config,
  sql: Sql,
  fetchImpl: typeof fetch = fetch,
  log: IngestLog = SILENT,
  now: () => Date = () => new Date(),
): Services {
  const audit = new AuditLog(sql);
  const oidc = config.oidc ? new OidcClient(config.oidc, fetchImpl) : null;
  const webhooks = new Webhooks(sql, audit, fetchImpl);
  const records = new Records(sql);
  const rateCards = new RateCards(sql, audit);
  const allocation = new Allocation(sql, audit);
  const budgets = new Budgets(sql, audit);
  const spend = new Spend(sql, allocation, budgets, rateCards, config.clicklandConsoleUrl, now);
  const landflow = config.landflow ? new LandflowClient(config.landflow.url, config.landflow.key, fetchImpl) : null;
  const clickland = config.clickland
    ? new ClicklandClient(config.clickland.url, config.clickland.key, fetchImpl, config.clickland.labels)
    : null;
  const ingest = new Ingest(sql, records, rateCards, {
    landflow,
    clickland,
    landflowHost: {
      service: config.landflow?.service ?? 'landflow-host',
      namespace: config.landflow?.namespace ?? 'landflow-dev',
    },
    dockerSharesCluster: config.dockerSharesCluster,
    log,
    now,
    // Records entered: allocate the months they landed in (their own, or the open month for a correction).
    afterRun: async (run) => {
      if (run.provisional || run.newCount + run.correctedCount === 0) return;
      for (const month of new Set([run.day.slice(0, 7), now().toISOString().slice(0, 7)]))
        await allocation.allocatePending(month);
    },
  });
  return {
    config,
    sql,
    audit,
    keys: new Keys(sql, audit),
    sessions: new Sessions(sql, config, audit, oidc),
    dimensions: new Dimensions(sql),
    webhooks,
    periods: new Periods(sql, audit, webhooks),
    records,
    rateCards,
    allocation,
    budgets,
    spend,
    ingest,
    landflow,
    log,
    fetchImpl,
  };
}

/** Small loops that claim due rows, so replicas can share the work: the webhook dispatcher and the cleanup. */
export function startBackgroundJobs(services: Services, log: (msg: string, err?: unknown) => void): () => void {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const loop = (name: string, everyMs: number, run: () => Promise<number>) => {
    const tick = async () => {
      if (stopped) return;
      let wait = everyMs;
      try {
        if ((await run()) > 0) wait = 50; // keep going while there is a backlog
      } catch (error) {
        log(`${name} failed`, error);
        wait = everyMs * 4;
      }
      if (!stopped) timers.add(setTimeout(tick, wait));
    };
    timers.add(setTimeout(tick, everyMs));
  };
  loop('webhook dispatcher', 2_000, () => services.webhooks.dispatchDue());
  loop('session cleanup', 3_600_000, async () => (await services.sessions.cleanup(), 0));
  const { config } = services;
  if (config.ingestJobs && services.ingest.sources().length) {
    // Ingest: every hour, today's provisional figures and the recent complete days (runner.ts tick); first after 20 s.
    loop('ingest', 3_600_000, async () => (await services.ingest.tick(), 0));
    timers.add(setTimeout(() => void services.ingest.tick().catch((e) => log('ingest failed', e)), 20_000));
  }
  if (config.ingestJobs && config.costMetricsEndpoint) {
    const endpoint = config.costMetricsEndpoint;
    loop('cost metrics', 300_000, async () => {
      const n = await emitCostMetrics(services.spend, endpoint, services.fetchImpl);
      services.log.info({ points: n, endpoint }, `cost metrics: ${n} points sent`);
      return 0;
    });
  }
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
