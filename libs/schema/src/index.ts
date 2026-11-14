import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** Where the SQL files live: `migrations/` next to `dist/` (and next to `src/` in tests). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** The local development database (deploy/compose.infra.yml; the password is the development one in .env.example). */
export const DEFAULT_PG_URL = 'postgres://landledger:landledger-dev@127.0.0.1:25532/landledger';

/**
 * Loads the env files into process.env without overriding what is already set, so every process reads the same
 * LANDLEDGER_* values: the starting directory's `.env.local` (an app's untracked keys, e.g. `apps/api/.env.local`),
 * then the workspace's `.env.local` and `.env`. `.env.example` documents them; the defaults are the local stack.
 * `.env.local` files are git-ignored: keys to Landflow and Clickland live there, never in git.
 */
export function loadWorkspaceEnv(from: string = process.cwd()): void {
  const start = resolve(from);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const files = [
        join(start, '.env.local'),
        join(dir, 'apps', 'api', '.env.local'),
        join(dir, '.env.local'),
        join(dir, '.env'),
      ];
      for (const file of new Set(files)) if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

export function postgresUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.LANDLEDGER_PG_URL ?? DEFAULT_PG_URL;
}

export interface Migration {
  /** The file name, `NNNN_name.sql`; the order is the name's. */
  name: string;
  sql: string;
  /** sha256 of the file, recorded when applied: a shipped migration that changes afterwards is refused. */
  checksum: string;
}

/**
 * The migrations, in order. The list is append-only: a change to the schema is a new file, never an edit of a shipped
 * one (the runner refuses a file whose checksum differs from the one it applied).
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  return files.map((name, i) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) throw new Error(`Bad migration name: ${name} (NNNN_name.sql)`);
    if (Number(name.slice(0, 4)) !== i + 1) throw new Error(`Migrations must be numbered 0001, 0002, …: ${name}`);
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * Applies the migrations not yet applied, each in its own transaction with its row in `_migrations`. Concurrent
 * runners wait on an advisory lock, so two processes never apply the same file twice.
 */
export async function migrate(
  url: string,
  log: (line: string) => void = () => {},
  migrations: Migration[] = loadMigrations(),
): Promise<string[]> {
  const sql = postgres(url, { onnotice: () => {}, max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('landledger:migrate'))`;
      await tx`CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())`;
      const done = new Map(
        (await tx<{ name: string; checksum: string }[]>`SELECT name, checksum FROM _migrations`).map((r) => [
          r.name,
          r.checksum,
        ]),
      );
      const applied: string[] = [];
      for (const m of migrations) {
        const had = done.get(m.name);
        if (had !== undefined) {
          if (had !== m.checksum)
            throw new Error(`${m.name} changed after it was applied: add a new migration instead of editing it`);
          continue;
        }
        await tx.savepoint(async (sp) => {
          await sp.unsafe(m.sql);
          await sp`INSERT INTO _migrations (name, checksum) VALUES (${m.name}, ${m.checksum})`;
        });
        applied.push(m.name);
        log(`postgres: applied ${m.name}`);
      }
      return applied;
    });
  } finally {
    await sql.end();
  }
}
