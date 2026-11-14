import { loadWorkspaceEnv, migrate, postgresUrlFromEnv } from './index.js';

loadWorkspaceEnv();
const applied = await migrate(postgresUrlFromEnv(), console.log);
console.log(`Migrations: ${applied.length} applied.`);
