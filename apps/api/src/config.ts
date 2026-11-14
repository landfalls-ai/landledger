import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { DEFAULT_PG_URL } from '@landledger/schema';
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
    auditAnchorMinutes: (() => {
      const n = Number(env.LANDLEDGER_AUDIT_ANCHOR_MINUTES ?? '60');
      if (!Number.isInteger(n) || n < 0)
        throw new Error('LANDLEDGER_AUDIT_ANCHOR_MINUTES is a whole number of minutes');
      return n;
    })(),
  };
}
