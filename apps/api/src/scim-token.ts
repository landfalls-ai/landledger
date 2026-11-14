/**
 * `pnpm scim:token [--name Landbright] [--out ~/.config/land-family/landledger-scim.env] [--url http://127.0.0.1:4810/scim/v2]`
 *
 * Mints a SCIM token for Landbright's push and writes it to an env file (mode 600, its folder 700) as
 * LANDLEDGER_SCIM_URL and LANDLEDGER_SCIM_TOKEN. The token is never printed; Landledger keeps only its sha256. Clickland's
 * `pnpm scim:token`, for Landledger.
 */
import { loadWorkspaceEnv } from '@landledger/schema';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { AuditLog } from './audit.js';
import { configFromEnv } from './config.js';
import { createSql } from './db.js';
import { ScimTokens } from './scim.js';

loadWorkspaceEnv();
const { values } = parseArgs({
  options: {
    name: { type: 'string', default: 'Landbright' },
    out: { type: 'string', default: '~/.config/land-family/landledger-scim.env' },
    url: { type: 'string', default: 'http://127.0.0.1:4810/scim/v2' },
  },
});

const out = values.out.startsWith('~/') ? `${homedir()}${values.out.slice(1)}` : values.out;
const sql = createSql(configFromEnv().postgresUrl);
try {
  const minted = await new ScimTokens(sql, new AuditLog(sql)).create(values.name, {
    actor: 'cli',
    actorKind: 'system',
  });
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  chmodSync(dirname(out), 0o700);
  writeFileSync(out, `LANDLEDGER_SCIM_URL=${values.url}\nLANDLEDGER_SCIM_TOKEN=${minted.token}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`SCIM token ${minted.id} ("${minted.name}", ${minted.prefix}…) written to ${out} (mode 600).`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
