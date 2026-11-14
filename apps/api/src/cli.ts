/**
 * `pnpm --filter @landledger/api ingest <command>`: ingest and its setup from the command line (spec 002).
 *
 *   run [--source landflow|clickland|all] [--day YYYY-MM-DD]   one run per source (default: all, today)
 *   backfill --source landflow|clickland --from YYYY-MM-DD      every day from --from to today
 *   tick                                                        what the hourly job does
 *   allocate [--month YYYY-MM]                                  allocate records entered since the last generation
 *   metrics                                                     send today's and yesterday's cost metrics once
 *
 * Runs are logged (pino → OpenTelemetry → Clickland) and recorded in ingest_runs, started by `cli`.
 */
import { loadWorkspaceEnv } from '@landledger/schema';
import { parseArgs } from 'node:util';
import { configFromEnv } from './config.js';
import { createSql } from './db.js';
import { emitCostMetrics } from './metrics.js';
import { createLogger } from './logger.js';
import { createServices } from './services.js';
import { stopTelemetry } from './telemetry.js';

loadWorkspaceEnv();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string', default: 'all' },
    day: { type: 'string' },
    from: { type: 'string' },
    version: { type: 'string', default: 'rcv_internal_1' },
    month: { type: 'string' },
  },
});
const config = configFromEnv();
const sql = createSql(config.postgresUrl);
const log = createLogger();
const services = createServices(config, sql, fetch, log);
const { ingest } = services;
const today = new Date().toISOString().slice(0, 10);
const sources = () => (values.source === 'all' ? ingest.sources() : [values.source as 'landflow' | 'clickland']);
const show = (r: {
  source: string;
  day: string;
  outcome: string;
  provisional: boolean;
  newCount: number;
  correctedCount: number;
  unchangedCount: number;
  warnings: string[];
  error: string | null;
}) =>
  console.log(
    `${r.source.padEnd(9)} ${r.day} ${r.provisional ? 'provisional' : 'ledger     '} ${r.outcome.padEnd(9)} new ${r.newCount}, corrected ${r.correctedCount}, unchanged ${r.unchangedCount}, warnings ${r.warnings.length}${r.error ? `: ${r.error}` : ''}`,
  );

try {
  switch (positionals[0]) {
    case 'run':
      for (const s of sources()) show(await ingest.run(s, values.day ?? today, 'manual', 'cli'));
      break;
    case 'backfill': {
      if (!values.from) throw new Error('backfill needs --from YYYY-MM-DD');
      for (const s of sources()) for (const r of await ingest.backfill(s, values.from, 'cli')) show(r);
      break;
    }
    case 'tick':
      for (const r of await ingest.tick()) show(r);
      break;
    case 'ai-lines':
      // Lines have an author, and their author can't approve them: a signed-in person adds them, in the console or
      // with POST /api/rate-cards/versions/:id/ai-lines.
      throw new Error('AI lines are added by a signed-in person: POST /api/rate-cards/versions/:id/ai-lines');
    case 'allocate': {
      const month = values.month ?? today.slice(0, 7);
      console.log(await services.allocation.allocatePending(month, { actor: 'cli', actorKind: 'system' }));
      break;
    }
    case 'metrics': {
      if (!config.costMetricsEndpoint) throw new Error('Cost metrics are off (LANDLEDGER_COST_METRICS=off)');
      console.log(
        `${await emitCostMetrics(services.spend, config.costMetricsEndpoint)} points sent to ${config.costMetricsEndpoint}`,
      );
      break;
    }
    default:
      console.log('ingest run | backfill --from DAY | tick | allocate | metrics (see src/cli.ts)');
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
  await stopTelemetry();
}
