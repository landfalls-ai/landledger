/**
 * `pnpm --filter @landledger/api anomaly <command>` (spec 007):
 *
 *   scan [--day YYYY-MM-DD]          what the hourly job does (today and yesterday), or one day's cost
 *   spike [--amount 25]              DEV ONLY: one provisional row today from the `dev-anomaly` source
 *   reverse                          DEV ONLY: takes every `dev-anomaly` row out again
 *   clickland-alert                  installs Clickland's alert rule on `landledger.event:cost.anomaly`
 *
 * `spike` and `reverse` are refused unless LANDLEDGER_DEV_ANOMALY=on and the database is on this machine. The spike
 * is never in the ledger (provisional rows are today's figures, not booked records), only the anomaly scan reads it, and
 * the hourly scan takes it out two hours later. Logs go pino → OpenTelemetry →
 * Clickland, so an anomaly found here reaches Clickland's alert rule as the API's would.
 */
import { loadWorkspaceEnv } from '@landledger/schema';
import { parseArgs } from 'node:util';
import { devReverse, devSpike, installClicklandAlert } from './anomalies.js';
import { configFromEnv } from './config.js';
import { createSql } from './db.js';
import { createLogger } from './logger.js';
import { createServices } from './services.js';
import { stopTelemetry } from './telemetry.js';

loadWorkspaceEnv();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { day: { type: 'string' }, amount: { type: 'string', default: '25' } },
});
const config = configFromEnv();
const sql = createSql(config.postgresUrl);
const log = createLogger();
const services = createServices(config, sql, fetch, log);
const today = new Date().toISOString().slice(0, 10);

try {
  switch (positionals[0]) {
    case 'scan': {
      const r = values.day
        ? { cost: (await services.anomalies.scanCost(values.day)).found, approval: 0 }
        : await services.anomalies.scan();
      console.log(JSON.stringify(r));
      break;
    }
    case 'spike': {
      const r = await devSpike(sql, services.audit, {
        enabled: config.devAnomaly ?? false,
        postgresUrl: config.postgresUrl,
        amount: values.amount,
        day: today,
        startedBy: 'anomaly-cli',
      });
      console.log(
        `dev-anomaly spike of $${values.amount} today (${today}): record ${r.recordId}, run ${r.runId}; the hourly scan takes it out at ${r.expiresAt}`,
      );
      break;
    }
    case 'reverse': {
      const r = await devReverse(sql, services.audit, {
        enabled: config.devAnomaly ?? false,
        postgresUrl: config.postgresUrl,
        startedBy: 'anomaly-cli',
      });
      console.log(`dev-anomaly rows removed: ${r.removed}; dev-anomaly records in the ledger: ${r.ledger}`);
      break;
    }
    case 'clickland-alert': {
      if (!config.clicklandApi)
        throw new Error('Set LANDLEDGER_CLICKLAND_ALERTS_KEY (a Clickland key with alerts:write)');
      const r = await installClicklandAlert(config.clicklandApi, config.consoleUrl);
      console.log(`Clickland alert ${r.id} ${r.created ? 'created' : 'brought up to date'}`);
      break;
    }
    default:
      console.error('usage: anomaly scan [--day YYYY-MM-DD] | spike [--amount 25] | reverse | clickland-alert');
      process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
  await stopTelemetry();
}
