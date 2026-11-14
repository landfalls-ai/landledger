import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { DEFAULT_PG_URL } from '@landledger/schema';
import { fileURLToPath } from 'node:url';
import { readHolidays } from './business-hours.js';
import { parseSecretKey } from './secrets.js';

/** Sign-in through Landbright: an OIDC relying party (authorization code + PKCE, client_secret_post). */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string;
}

/** The API's configuration, from LANDLEDGER_* variables (.env.example). Defaults are the local dev stack. */
export interface Config {
  port: number;
  host: string;
  postgresUrl: string;
  /** Where people open Landledger (links, CORS, the cookie's Secure flag). */
  consoleUrl: string;
  /** An admin key that exists while it is set (for scripts before any key exists). */
  bootstrapKey: string | null;
  /** Local only: calls with neither a session nor a key act as a local developer. Off unless LANDLEDGER_DEV_AUTH=on. */
  devAuth: boolean;
  sessionHours: number;
  /** Null when no client secret is available yet; `oidcProblem` says why. */
  oidc: OidcConfig | null;
  oidcProblem: string | null;
  /** Off in tests: the outbox dispatcher and the cleanup loop. */
  backgroundJobs: boolean;
  /** Landflow (AI usage), read with an owner or admin `lf_` key; null until both are set. */
  landflow: { url: string; key: string; service: string; namespace: string } | null;
  /** Clickland (resource usage, and where cost metrics go), read with a `usage:read` key; null until both are set. */
  clickland: { url: string; key: string; labels: string[] } | null;
  /** Clickland's console, for links to a service's page. */
  clicklandConsoleUrl: string;
  /** Where cost metrics are sent (OTLP over HTTP, JSON); null turns them off. */
  costMetricsEndpoint: string | null;
  /** Ingest every hour (and cost metrics every few minutes) when background jobs run; LANDLEDGER_INGEST=off stops it. */
  ingestJobs: boolean;
  /**
   * The Kubernetes cluster whose node the Docker engine runs on (OrbStack runs both in one machine): Docker's usage is
   * taken out of that node's idle, so the day adds up to capacity × rate once. Null when Docker has its own host.
   */
  dockerSharesCluster: string | null;
  /** How often the audit chain's head is anchored outside the database (minutes; 0 turns it off). */
  auditAnchorMinutes: number;
  /**
   * LANDLEDGER_SECRET_KEY: seals session ID tokens and webhook secrets at rest (AES-256-GCM, secrets.ts). Null: no ID
   * token is kept and webhooks can't be created.
   */
  secretKey: Buffer | null;
  /** Business hours a pending step waits before it escalates (LANDLEDGER_STEP_DEADLINE_HOURS, default 24). */
  stepDeadlineHours: number;
  /** The business days (0 Sunday … 6 Saturday, in `timeZone`) deadlines count (LANDLEDGER_BUSINESS_DAYS, default Mon–Fri). */
  businessDays: number[];
  /** The time zone business days are counted in, and times are shown in (LANDLEDGER_TZ, default UTC). */
  timeZone: string;
  /** Local dates that never count as business days (LANDLEDGER_HOLIDAYS_FILE, default deploy/holidays.txt). */
  holidays: Set<string>;
  /** Wave 3 (spec 005): reconciliation tolerance, percent (LANDLEDGER_RECONCILE_TOLERANCE_PCT, default 2). */
  reconcileTolerancePct?: string;
  /** Wave 3 (spec 007): the smallest daily jump that is an anomaly, USD (LANDLEDGER_ANOMALY_MIN_USD, default 1). */
  anomalyMinUsd?: string;
  /** Wave 3 (spec 007): the dev-only spike path (LANDLEDGER_DEV_ANOMALY=on), never in production. */
  devAnomaly?: boolean;
  /**
   * Wave 3 (specs 007, 008): Clickland's Agent Value (a `read` key) and alert rules (an `alerts:write` key); null until
   * set (LANDLEDGER_CLICKLAND_VALUE_KEY, LANDLEDGER_CLICKLAND_ALERTS_KEY, LANDLEDGER_CLICKLAND_API_URL).
   */
  clicklandApi?: { url: string; valueKey: string | null; alertsKey: string | null } | null;
  /** Wave 3 (spec 009): days before a contract's notice date its renewal shows (LANDLEDGER_RENEWAL_WINDOW_DAYS, 30). */
  renewalWindowDays?: number;
}

/** deploy/holidays.txt in the workspace (src/ and dist/ sit at the same depth). */
export const DEFAULT_HOLIDAYS_FILE = fileURLToPath(new URL('../../../deploy/holidays.txt', import.meta.url));

/** An IANA time zone Intl knows, or throws. */
export function parseTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    throw new Error(`LANDLEDGER_TZ: "${value}" is not a time zone (Asia/Jerusalem, UTC)`);
  }
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `mon-fri`, `sun-thu`, `mon,tue,wed`: the business days, as UTC weekday numbers. */
export function parseBusinessDays(value: string): number[] {
  const out = new Set<number>();
  for (const part of value
    .toLowerCase()
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [a, b] = part.split('-').map((d) => DAY_NAMES.indexOf(d.slice(0, 3)));
    if (a === undefined || a < 0 || (b !== undefined && b < 0))
      throw new Error(`LANDLEDGER_BUSINESS_DAYS: "${part}" is not a day or a range of days (mon-fri)`);
    if (b === undefined) out.add(a);
    else
      for (let d = a; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === b) break;
      }
  }
  if (!out.size) throw new Error('LANDLEDGER_BUSINESS_DAYS names no day');
  return [...out].sort();
}

const expandHome = (path: string) => (path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path);

/** The Landbright client file (LANDBRIGHT_ISSUER, LANDBRIGHT_CLIENT_ID, LANDBRIGHT_CLIENT_SECRET, …), if it exists. */
export function readClientFile(path: string): Record<string, string> | null {
  const file = expandHome(path);
  if (!existsSync(file)) return null;
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.LANDLEDGER_API_HOST ?? '127.0.0.1';
  const devAuth = env.LANDLEDGER_DEV_AUTH === 'on';
  if (devAuth && !LOOPBACK.has(host))
    throw new Error(`LANDLEDGER_DEV_AUTH=on is for this machine only; the API listens on ${host}`);
  const consoleUrl = (env.LANDLEDGER_CONSOLE_URL ?? 'http://localhost:4811').replace(/\/$/, '');

  const clientFile = env.LANDLEDGER_OIDC_ENV_FILE ?? '~/.config/land-family/landledger-local.env';
  const file = readClientFile(clientFile);
  const secret = env.LANDLEDGER_OIDC_CLIENT_SECRET ?? file?.LANDBRIGHT_CLIENT_SECRET ?? null;
  const method = file?.LANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD ?? 'client_secret_post';
  let oidc: OidcConfig | null = null;
  let oidcProblem: string | null = null;
  if (!secret) oidcProblem = `No client secret: ${clientFile} doesn't exist yet (Landbright's session writes it)`;
  else if (method !== 'client_secret_post')
    oidcProblem = `The Landbright client uses ${method}; Landledger sends client_secret_post`;
  else
    oidc = {
      issuer: (env.LANDLEDGER_OIDC_ISSUER ?? file?.LANDBRIGHT_ISSUER ?? 'http://localhost:4402/oidc').replace(
        /\/$/,
        '',
      ),
      clientId: env.LANDLEDGER_OIDC_CLIENT_ID ?? file?.LANDBRIGHT_CLIENT_ID ?? 'landledger-local',
      clientSecret: secret,
      redirectUri: env.LANDLEDGER_OIDC_REDIRECT_URI ?? `${consoleUrl}/api/auth/oidc/callback`,
      postLogoutRedirectUri: env.LANDLEDGER_OIDC_POST_LOGOUT_REDIRECT_URI ?? `${consoleUrl}/`,
      scopes: 'openid email profile roles',
    };

  const sessionHours = Number(env.LANDLEDGER_SESSION_HOURS ?? 8);
  if (!(sessionHours > 0 && sessionHours <= 24 * 30)) throw new Error('LANDLEDGER_SESSION_HOURS is 1 to 720');
  return {
    port: Number(env.LANDLEDGER_API_PORT ?? 4810),
    host,
    postgresUrl: env.LANDLEDGER_PG_URL ?? DEFAULT_PG_URL,
    consoleUrl,
    bootstrapKey: env.LANDLEDGER_BOOTSTRAP_KEY || null,
    devAuth,
    sessionHours,
    oidc,
    oidcProblem,
    backgroundJobs: env.LANDLEDGER_BACKGROUND_JOBS !== 'off',
    landflow:
      env.LANDLEDGER_LANDFLOW_URL && env.LANDLEDGER_LANDFLOW_KEY
        ? {
            url: env.LANDLEDGER_LANDFLOW_URL.replace(/\/$/, ''),
            key: env.LANDLEDGER_LANDFLOW_KEY,
            service: env.LANDLEDGER_LANDFLOW_SERVICE ?? 'landflow-host',
            namespace: env.LANDLEDGER_LANDFLOW_NAMESPACE ?? 'landflow-dev',
          }
        : null,
    clickland:
      env.LANDLEDGER_CLICKLAND_URL && env.LANDLEDGER_CLICKLAND_KEY
        ? {
            url: env.LANDLEDGER_CLICKLAND_URL.replace(/\/$/, ''),
            key: env.LANDLEDGER_CLICKLAND_KEY,
            labels: (env.LANDLEDGER_CLICKLAND_LABELS ?? '')
              .split(',')
              .map((l) => l.trim())
              .filter(Boolean),
          }
        : null,
    clicklandConsoleUrl: (env.LANDLEDGER_CLICKLAND_CONSOLE_URL ?? 'http://localhost:4711').replace(/\/$/, ''),
    costMetricsEndpoint:
      env.LANDLEDGER_COST_METRICS === 'off'
        ? null
        : (env.LANDLEDGER_COST_METRICS_ENDPOINT ??
          `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:24318').replace(/\/$/, '')}/v1/metrics`),
    ingestJobs: env.LANDLEDGER_INGEST !== 'off',
    dockerSharesCluster:
      (env.LANDLEDGER_DOCKER_SHARES_CLUSTER ?? 'orbstack') === 'none'
        ? null
        : (env.LANDLEDGER_DOCKER_SHARES_CLUSTER ?? 'orbstack') || null,
    secretKey: env.LANDLEDGER_SECRET_KEY ? parseSecretKey(env.LANDLEDGER_SECRET_KEY) : null,
    stepDeadlineHours: (() => {
      const n = Number(env.LANDLEDGER_STEP_DEADLINE_HOURS ?? '24');
      if (!Number.isInteger(n) || n < 1 || n > 24 * 30)
        throw new Error('LANDLEDGER_STEP_DEADLINE_HOURS is a whole number of business hours, 1 to 720');
      return n;
    })(),
    businessDays: parseBusinessDays(env.LANDLEDGER_BUSINESS_DAYS ?? 'mon-fri'),
    timeZone: parseTimeZone(env.LANDLEDGER_TZ ?? 'UTC'),
    holidays: readHolidays(
      env.LANDLEDGER_HOLIDAYS_FILE === 'none'
        ? null
        : expandHome(env.LANDLEDGER_HOLIDAYS_FILE ?? DEFAULT_HOLIDAYS_FILE),
    ),
    reconcileTolerancePct: (() => {
      const v = env.LANDLEDGER_RECONCILE_TOLERANCE_PCT ?? '2';
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(v))
        throw new Error('LANDLEDGER_RECONCILE_TOLERANCE_PCT is a percent, 0 to 99.99');
      return v;
    })(),
    anomalyMinUsd: (() => {
      const v = env.LANDLEDGER_ANOMALY_MIN_USD ?? '1';
      if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error('LANDLEDGER_ANOMALY_MIN_USD is an amount in USD');
      return v;
    })(),
    devAnomaly: (() => {
      const on = env.LANDLEDGER_DEV_ANOMALY === 'on';
      if (on && !LOOPBACK.has(host)) throw new Error('LANDLEDGER_DEV_ANOMALY=on is for this machine only');
      return on;
    })(),
    clicklandApi:
      env.LANDLEDGER_CLICKLAND_VALUE_KEY || env.LANDLEDGER_CLICKLAND_ALERTS_KEY
        ? {
            url: (env.LANDLEDGER_CLICKLAND_API_URL ?? env.LANDLEDGER_CLICKLAND_URL ?? 'http://localhost:4710').replace(
              /\/$/,
              '',
            ),
            valueKey: env.LANDLEDGER_CLICKLAND_VALUE_KEY || null,
            alertsKey: env.LANDLEDGER_CLICKLAND_ALERTS_KEY || null,
          }
        : null,
    renewalWindowDays: (() => {
      const n = Number(env.LANDLEDGER_RENEWAL_WINDOW_DAYS ?? '30');
      if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error('LANDLEDGER_RENEWAL_WINDOW_DAYS is 0 to 365');
      return n;
    })(),
    auditAnchorMinutes: (() => {
      const n = Number(env.LANDLEDGER_AUDIT_ANCHOR_MINUTES ?? '60');
      if (!Number.isInteger(n) || n < 0)
        throw new Error('LANDLEDGER_AUDIT_ANCHOR_MINUTES is a whole number of minutes');
      return n;
    })(),
  };
}
