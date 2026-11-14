import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { APP_ROLE, DEFAULT_APP_PG_PASSWORD, migrate, ownerUrlFromEnv, setAppPassword } from './index.js';

/**
 * Integration tests run against the real Postgres only when LANDLEDGER_INTEGRATION names `db` (`db` or `all` or a
 * comma list); otherwise they skip.
 */
export function integrationEnabled(name = 'db', env: NodeJS.ProcessEnv = process.env): boolean {
  const flags = (env.LANDLEDGER_INTEGRATION ?? '').split(',').map((s) => s.trim());
  return flags.includes(name) || flags.includes('all');
}

export interface TestDatabase {
  /** As the owner (migrations, and tests that show even the owner is refused). */
  url: string;
  /** As `landledger_app`, the role the API connects as (migration 0008). */
  appUrl: string;
  name: string;
  drop(): Promise<void>;
}

/**
 * A fresh, migrated database for one test file (`landledger_test_<random>`) on the server LANDLEDGER_OWNER_PG_URL
 * names, with URLs for the owner and the app role; `drop()` removes it. The development database is never touched.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const base = new URL(ownerUrlFromEnv());
  const name = `landledger_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(base.toString(), { onnotice: () => {}, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (options.migrate !== false) {
    await migrate(url.toString());
    await setAppPassword(url.toString(), process.env.LANDLEDGER_APP_PG_PASSWORD ?? DEFAULT_APP_PG_PASSWORD);
  }
  const app = new URL(url);
  app.username = APP_ROLE;
  app.password = process.env.LANDLEDGER_APP_PG_PASSWORD ?? DEFAULT_APP_PG_PASSWORD;
  return {
    url: url.toString(),
    appUrl: app.toString(),
    name,
    async drop() {
      const sql = postgres(base.toString(), { onnotice: () => {}, max: 1 });
      try {
        await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await sql.end();
      }
    },
  };
}
