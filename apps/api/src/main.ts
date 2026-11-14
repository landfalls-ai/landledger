import { loadWorkspaceEnv } from '@landledger/schema';
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { createSql } from './db.js';
import { createLogger } from './logger.js';
import { sealLegacySecrets, SecretBox } from './secrets.js';
import { createServices, startBackgroundJobs } from './services.js';
import { stopTelemetry } from './telemetry.js';

loadWorkspaceEnv();
const config = configFromEnv();
const sql = createSql(config.postgresUrl);
const logger = createLogger();
const services = createServices(config, sql, fetch, logger);
const app = await buildApp(services, { loggerInstance: logger });

// Secrets written before they were sealed: sealed now (or, with no key, ID tokens dropped).
const sealed = await sealLegacySecrets(sql, config.secretKey ? new SecretBox(config.secretKey) : null);
if (sealed) app.log.info(`secrets at rest: ${sealed} legacy row(s) ${config.secretKey ? 'sealed' : 'cleared'}`);
if (!config.secretKey)
  app.log.warn('LANDLEDGER_SECRET_KEY is not set: sessions keep no ID token and webhooks cannot be created');

const stopJobs = config.backgroundJobs
  ? startBackgroundJobs(services, (msg, err) => app.log.error({ err }, msg))
  : () => {};

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  stopJobs();
  await app.close();
  await sql.end();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
if (config.devAuth) app.log.warn('LANDLEDGER_DEV_AUTH=on: calls without a session or key act as a local developer');
if (!config.oidc) app.log.warn(`Sign-in with Landbright is off: ${config.oidcProblem}`);
else app.log.info(`Sign-in with Landbright: ${config.oidc.issuer}, client ${config.oidc.clientId}`);
app.log.info(
  `Ingest: Landflow ${config.landflow ? config.landflow.url : 'off (no LANDLEDGER_LANDFLOW_URL/KEY)'}; Clickland ${config.clickland ? config.clickland.url : 'off (no LANDLEDGER_CLICKLAND_URL/KEY)'}; jobs ${config.backgroundJobs && config.ingestJobs ? 'on' : 'off'}`,
);
