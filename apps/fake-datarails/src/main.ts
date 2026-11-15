/** fake-datarails' entry: development credentials from the environment (the defaults match `.env.example`). */
import { FakeDatarails } from './server.js';

const env = process.env;
const port = Number(env.FAKE_DATARAILS_PORT ?? 4819);
const host = env.FAKE_DATARAILS_HOST ?? '127.0.0.1';
const fake = new FakeDatarails({
  mcpToken: env.FAKE_DATARAILS_MCP_TOKEN ?? 'fake-datarails-dev-token',
  user: env.FAKE_DATARAILS_USER ?? 'landledger-sync',
  password: env.FAKE_DATARAILS_PASSWORD ?? 'fake-datarails-dev',
  dataDir: env.FAKE_DATARAILS_DATA ?? './data',
});
fake.server().listen(port, host, () => console.log(`fake-datarails on http://${host}:${port} (MCP at /mcp)`));
