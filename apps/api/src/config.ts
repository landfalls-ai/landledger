import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { DEFAULT_PG_URL } from '@landledger/schema';

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
  };
}
