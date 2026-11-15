/**
 * fake-datarails (wave 4, spec 017): a stand-in for a Datarails tenant on this machine, so Landledger's connector is
 * built and tested without a real one. Two surfaces, the two the connector uses:
 *
 * - `POST /mcp`: an MCP server (JSON-RPC 2.0 over streamable HTTP, JSON responses) with Bearer auth and read tools
 *   only: `list_data_models`, `list_aliased_fields`, `list_business_metrics`, `query_data_model`, `list_filebox`.
 *   Rows come back keyed by field ids, as Datarails' do; `list_aliased_fields` names them.
 * - `POST /api/v1/fileboxes/upload_file`: the FileBox upload, multipart with Basic auth. Files are kept on disk and
 *   listed by `GET /api/v1/fileboxes/:id/files`.
 *
 * Nothing here is a real Datarails API contract: the shapes are close enough to exercise the connector. Development
 * credentials only (`deploy/compose.fake.yml`, `.env.example`).
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

export interface FakeConfig {
  mcpToken: string;
  user: string;
  password: string;
  dataDir: string;
}

export const PROTOCOL_VERSION = '2025-06-18';
export const VERSION = '0.1.0';

// The tenant's data --------------------------------------------------------------------------------------------------

export const DATA_MODELS = [
  {
    id: 'dm_budget_fy27',
    name: 'Budget',
    description: 'Technology and AI budget by cost center and month (FY27 plan and the Q1 reforecast)',
    rows: 0,
  },
  {
    id: 'dm_actuals_tech',
    name: 'Technology actuals',
    description: 'Monthly actuals uploaded from Landledger',
    rows: 0,
  },
];

export const FIELDS: Record<string, Array<{ id: string; alias: string; name: string; type: string }>> = {
  dm_budget_fy27: [
    { id: 'f_1001', alias: 'cost_center', name: 'Cost Center', type: 'string' },
    { id: 'f_1002', alias: 'period', name: 'Period', type: 'month' },
    { id: 'f_1003', alias: 'scenario', name: 'Scenario', type: 'string' },
    { id: 'f_1004', alias: 'account', name: 'Account', type: 'string' },
    { id: 'f_1005', alias: 'amount', name: 'Amount', type: 'number' },
    { id: 'f_1006', alias: 'currency', name: 'Currency', type: 'string' },
  ],
  dm_actuals_tech: [
    { id: 'f_2001', alias: 'cost_center', name: 'Cost Center', type: 'string' },
    { id: 'f_2002', alias: 'period', name: 'Period', type: 'month' },
    { id: 'f_2003', alias: 'amount', name: 'Amount', type: 'number' },
  ],
};

export const METRICS = [
  { id: 'bm_tech_spend', name: 'Technology spend', formula: 'sum(amount) where account = Technology & AI' },
  { id: 'bm_ai_share', name: 'AI share of technology spend', formula: 'ai_spend / tech_spend' },
  { id: 'bm_budget_variance', name: 'Budget variance', formula: 'actual - budget' },
];

const MONTHS = ['2026-12', '2027-01', '2027-02', '2027-03'];
const BASE: Record<string, number> = {
  'SHARED-POOL': 260,
  'ENG-AGENTS': 70,
  'ENG-PLATFORM': 45,
  'ENG-PRODUCT': 12,
  'RND-DATA': 10,
  'CS-SUPPORT': 2,
  'GA-IT': 6,
};

/** The budget rows, keyed by field id: deterministic, December 2026 to March 2027, two scenarios. */
export function budgetRows(): Array<Record<string, string | number>> {
  const out: Array<Record<string, string | number>> = [];
  for (const scenario of ['Budget FY27', 'Reforecast Q1']) {
    MONTHS.forEach((m, i) => {
      for (const [cc, base] of Object.entries(BASE)) {
        const grow = scenario === 'Budget FY27' ? 1 + i * 0.05 : 1.1 + i * 0.05;
        out.push({
          f_1001: cc,
          f_1002: m,
          f_1003: scenario,
          f_1004: 'Technology & AI',
          f_1005: Math.round(base * grow * 100) / 100,
          f_1006: 'USD',
        });
      }
    });
  }
  return out;
}

// HTTP helpers --------------------------------------------------------------------------------------------------------

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function bearerOk(req: IncomingMessage, token: string) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') && same(h.slice(7), token);
}

function basicOk(req: IncomingMessage, user: string, password: string) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return same(u ?? '', user) && same(p.join(':'), password);
}

export interface Part {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

/** A multipart/form-data body, split into its parts. */
export function parseMultipart(body: Buffer, contentType: string): Part[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('no boundary');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts: Part[] = [];
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const start = at + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next < 0) break;
    const chunk = body.subarray(start + 2, next - 2); // past CRLF; before CRLF
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, split).toString('utf8');
    const data = chunk.subarray(split + 4);
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(head)?.[1] ?? null;
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
    parts.push({ name, filename, contentType: ct, data: Buffer.from(data) });
    at = next;
  }
  return parts;
}

// MCP -----------------------------------------------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_data_models',
    description: 'Lists the data models of the tenant.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_aliased_fields',
    description: "Lists a data model's fields with their aliases.",
    inputSchema: {
      type: 'object',
      properties: { data_model_id: { type: 'string' } },
      required: ['data_model_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_business_metrics',
    description: 'Lists the business metrics defined in the tenant.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'query_data_model',
    description: "Reads a data model's rows, keyed by field id; filters by field alias.",
    inputSchema: {
      type: 'object',
      properties: {
        data_model_id: { type: 'string' },
        filters: { type: 'object', additionalProperties: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: ['data_model_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_filebox',
    description: 'Lists the files uploaded to a FileBox.',
    inputSchema: { type: 'object', properties: { filebox_id: { type: 'string' } }, required: ['filebox_id'] },
    annotations: { readOnlyHint: true },
  },
];

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

export class FakeDatarails {
  constructor(private readonly config: FakeConfig) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  private uploadsFile() {
    return join(this.config.dataDir, 'uploads.json');
  }

  uploads(): Array<{
    id: string;
    filebox_id: string;
    at: string;
    files: Array<{ name: string; size: number; sha256: string; path: string }>;
  }> {
    return existsSync(this.uploadsFile()) ? JSON.parse(readFileSync(this.uploadsFile(), 'utf8')) : [];
  }

  private tool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'list_data_models':
        return {
          data_models: DATA_MODELS.map((d) => ({ ...d, rows: d.id === 'dm_budget_fy27' ? budgetRows().length : 0 })),
        };
      case 'list_aliased_fields': {
        const f = FIELDS[String(args.data_model_id)];
        if (!f) throw new Error(`Unknown data model ${String(args.data_model_id)}`);
        return { data_model_id: args.data_model_id, fields: f };
      }
      case 'list_business_metrics':
        return { metrics: METRICS };
      case 'query_data_model': {
        const id = String(args.data_model_id);
        const fields = FIELDS[id];
        if (!fields) throw new Error(`Unknown data model ${id}`);
        let rows: Array<Record<string, string | number>> = id === 'dm_budget_fy27' ? budgetRows() : [];
        const filters = (args.filters ?? {}) as Record<string, string>;
        for (const [alias, value] of Object.entries(filters)) {
          const f = fields.find((x) => x.alias === alias);
          if (!f) throw new Error(`Unknown field alias ${alias}`);
          rows = rows.filter((r) => String(r[f.id]) === value);
        }
        const limit = Math.min(Number(args.limit ?? 5000), 5000);
        return { data_model_id: id, total: rows.length, rows: rows.slice(0, limit) };
      }
      case 'list_filebox':
        return {
          filebox_id: args.filebox_id,
          files: this.uploads()
            .filter((u) => u.filebox_id === args.filebox_id)
            .flatMap((u) =>
              u.files.map((f) => ({ upload_id: u.id, at: u.at, name: f.name, size: f.size, sha256: f.sha256 })),
            ),
        };
      default:
        throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
    }
  }

  private rpc(m: Rpc): unknown {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fake-datarails', version: VERSION },
          instructions: 'A fake Datarails tenant for local development. Read tools only.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = String(m.params?.name ?? '');
        try {
          const out = this.tool(name, (m.params?.arguments ?? {}) as Record<string, unknown>);
          return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false });
        } catch (e) {
          if ((e as { code?: number }).code === -32602) return fail(-32602, (e as Error).message);
          return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return send(res, 200, { status: 'ok', fake: true, name: 'fake-datarails', version: VERSION });
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only (streamable HTTP, JSON responses)' });
        if (!bearerOk(req, this.config.mcpToken)) return send(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)).toString('utf8')) as Rpc | Rpc[];
        const list = Array.isArray(body) ? body : [body];
        const out = list.filter((m) => m.id !== undefined).map((m) => this.rpc(m));
        if (!out.length) {
          res.writeHead(202).end();
          return;
        }
        res.setHeader('mcp-session-id', 'fake-session');
        return send(res, 200, Array.isArray(body) ? out : out[0]);
      }
      if (url.pathname === '/api/v1/fileboxes/upload_file' && req.method === 'POST') {
        if (!basicOk(req, this.config.user, this.config.password)) return send(res, 401, { error: 'unauthorized' });
        const ct = req.headers['content-type'] ?? '';
        if (!ct.startsWith('multipart/form-data')) return send(res, 415, { error: 'multipart/form-data only' });
        const parts = parseMultipart(await readBody(req), ct);
        const filebox = parts
          .find((p) => p.name === 'filebox_id')
          ?.data.toString('utf8')
          .trim();
        const files = parts.filter((p) => p.filename);
        if (!filebox) return send(res, 400, { error: 'filebox_id is required' });
        if (!files.length) return send(res, 400, { error: 'no file' });
        const id = `up_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const dir = join(this.config.dataDir, filebox, id);
        mkdirSync(dir, { recursive: true });
        const stored = files.map((f) => {
          const name = f.filename!.replace(/[^\w.-]/g, '_');
          writeFileSync(join(dir, name), f.data);
          return {
            name,
            size: f.data.length,
            sha256: createHash('sha256').update(f.data).digest('hex'),
            path: join(filebox, id, name),
          };
        });
        const at = new Date().toISOString();
        writeFileSync(
          this.uploadsFile(),
          JSON.stringify([...this.uploads(), { id, filebox_id: filebox, at, files: stored }], null, 2),
        );
        return send(res, 201, {
          status: 'uploaded',
          upload_id: id,
          filebox_id: filebox,
          received_at: at,
          files: stored.map(({ path: _p, ...f }) => f),
        });
      }
      const list = /^\/api\/v1\/fileboxes\/([\w-]+)\/files$/.exec(url.pathname);
      if (list && req.method === 'GET') {
        if (!basicOk(req, this.config.user, this.config.password)) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, {
          filebox_id: list[1],
          files: this.uploads()
            .filter((u) => u.filebox_id === list[1])
            .flatMap((u) => u.files.map(({ path: _p, ...f }) => ({ upload_id: u.id, at: u.at, ...f }))),
        });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const fileboxes = existsSync(this.config.dataDir)
          ? readdirSync(this.config.dataDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
          : [];
        return send(res, 200, { name: 'fake-datarails', fake: true, fileboxes, uploads: this.uploads().length });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  server(): Server {
    return createServer((req, res) => void this.handle(req, res));
  }
}
