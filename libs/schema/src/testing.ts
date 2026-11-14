import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { migrate, postgresUrlFromEnv } from './index.js';

/**
 * Integration tests run against the real Postgres only when LANDLEDGER_INTEGRATION names `db` (`db` or `all` or a
 * comma list); otherwise they skip.
 */
export function integrationEnabled(name = 'db', env: NodeJS.ProcessEnv = process.env): boolean {
  const flags = (env.LANDLEDGER_INTEGRATION ?? '').split(',').map((s) => s.trim());
  return flags.includes(name) || flags.includes('all');
}

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/**
 * A fresh, migrated database for one test file (`landledger_test_<random>`) on the server LANDLEDGER_PG_URL names;
 * `drop()` removes it. The development database is never touched.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const base = new URL(postgresUrlFromEnv());
  const name = `landledger_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(base.toString(), { onnotice: () => {}, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (options.migrate !== false) await migrate(url.toString());
  return {
    url: url.toString(),
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
