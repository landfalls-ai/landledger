import { DEFAULT_APP_PG_PASSWORD, loadWorkspaceEnv, migrate, ownerUrlFromEnv, setAppPassword } from './index.js';

// Migrations run as the owner; then the app role (created by 0008) gets LOGIN and its password.
loadWorkspaceEnv();
const owner = ownerUrlFromEnv();
const applied = await migrate(owner, console.log);
console.log(`Migrations: ${applied.length} applied.`);
await setAppPassword(owner, process.env.LANDLEDGER_APP_PG_PASSWORD ?? DEFAULT_APP_PG_PASSWORD);
console.log('Role landledger_app: LOGIN, password from LANDLEDGER_APP_PG_PASSWORD.');
