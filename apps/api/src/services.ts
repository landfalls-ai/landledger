import { AuditLog } from './audit.js';
import { Sessions } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { Dimensions } from './dimensions.js';
import { Keys } from './keys.js';
import { Periods, Records } from './ledger.js';
import { OidcClient } from './oidc.js';
import { Webhooks } from './webhooks.js';

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
}

export function createServices(config: Config, sql: Sql, fetchImpl: typeof fetch = fetch): Services {
  const audit = new AuditLog(sql);
  const oidc = config.oidc ? new OidcClient(config.oidc, fetchImpl) : null;
  const webhooks = new Webhooks(sql, audit, fetchImpl);
  return {
    config,
    sql,
    audit,
    keys: new Keys(sql, audit),
    sessions: new Sessions(sql, config, audit, oidc),
    dimensions: new Dimensions(sql),
    webhooks,
    periods: new Periods(sql, audit, webhooks),
    records: new Records(sql),
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
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
