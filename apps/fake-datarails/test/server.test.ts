import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetRows, FakeDatarails, parseMultipart } from '../src/server.js';

const config = { mcpToken: 't0k', user: 'u', password: 'p', dataDir: mkdtempSync(join(tmpdir(), 'fdr-')) };
const server = new FakeDatarails(config).server();
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const rpc = (body: unknown, token = 't0k') =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (
    (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()) as {
      result: { structuredContent: Record<string, unknown>; isError: boolean };
    }
  ).result;

describe('fake-datarails MCP', () => {
  it('refuses a wrong token', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(401);
  });

  it('initializes and lists read tools only', async () => {
    const init = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe('fake-datarails');
    const tools = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    expect(tools.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_data_models', 'list_aliased_fields', 'list_business_metrics']),
    );
    expect(tools.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it('answers a notification with 202 and no body', async () => {
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('reads the budget by field id, filtered by alias', async () => {
    const models = await call('list_data_models');
    expect((models.structuredContent.data_models as Array<{ name: string }>).map((m) => m.name)).toContain('Budget');
    const fields = await call('list_aliased_fields', { data_model_id: 'dm_budget_fy27' });
    expect((fields.structuredContent.fields as Array<{ alias: string }>).map((f) => f.alias)).toContain('amount');
    const q = await call('query_data_model', { data_model_id: 'dm_budget_fy27', filters: { scenario: 'Budget FY27' } });
    const rows = q.structuredContent.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(budgetRows().length / 2);
    expect(rows[0]).toHaveProperty('f_1005');
    expect(new Set(rows.map((r) => r.f_1002))).toEqual(new Set(['2026-12', '2027-01', '2027-02', '2027-03']));
    expect((await call('list_business_metrics')).structuredContent.metrics).toHaveLength(3);
    expect((await call('query_data_model', { data_model_id: 'nope' })).isError).toBe(true);
  });
});

describe('fake-datarails FileBox upload', () => {
  const basic = `Basic ${Buffer.from('u:p').toString('base64')}`;
  const form = () => {
    const f = new FormData();
    f.set('filebox_id', 'fb_test');
    f.append('file', new Blob(['a,b\n1,2\n']), 'actuals.csv');
    f.append('file', new Blob(['x\n']), 'notes.csv');
    return f;
  };

  it('refuses without Basic auth', async () => {
    const r = await fetch(`${base}/api/v1/fileboxes/upload_file`, { method: 'POST', body: form() });
    expect(r.status).toBe(401);
  });

  it('stores the files and lists them, with their sha256', async () => {
    const r = await fetch(`${base}/api/v1/fileboxes/upload_file`, {
      method: 'POST',
      body: form(),
      headers: { authorization: basic },
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      upload_id: string;
      files: Array<{ name: string; sha256: string; size: number }>;
    };
    expect(body.files.map((f) => f.name)).toEqual(['actuals.csv', 'notes.csv']);
    expect(body.files[0]!.size).toBe(8);
    const list = (await (
      await fetch(`${base}/api/v1/fileboxes/fb_test/files`, { headers: { authorization: basic } })
    ).json()) as {
      files: Array<{ upload_id: string }>;
    };
    expect(list.files.filter((f) => f.upload_id === body.upload_id)).toHaveLength(2);
    const mcp = await call('list_filebox', { filebox_id: 'fb_test' });
    expect((mcp.structuredContent.files as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('parses multipart with a quoted boundary', () => {
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n--b--\r\n');
    expect(parseMultipart(body, 'multipart/form-data; boundary="b"')).toEqual([
      { name: 'x', filename: null, contentType: null, data: Buffer.from('hi') },
    ]);
  });
});
