/**
 * Landledger's MCP server (spec 002/003, wave 1): stateless Streamable HTTP at `POST /api/mcp`, Clickland's pattern —
 * one server per request, bound to the caller (a key with `read`, or a signed-in person). Two read-only tools:
 * `spend_by` (spend grouped by a dimension) and `budget_status` (each cost center against its budget). Amounts are
 * decimal strings in USD; nothing an agent calls here changes the ledger.
 */
import { Dimension, DIMENSION_LABEL } from '@landledger/contracts';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION } from './version.js';
import { ApiError } from './errors.js';
import { type Principal, requireScope } from './principal.js';
import type { Spend } from './spend.js';

const ok = (data: unknown, text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (error: unknown): CallToolResult => ({
  content: [
    {
      type: 'text',
      text:
        error instanceof ApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
    },
  ],
  isError: true,
});

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Day = z.iso.date();

export const SpendByInput = z.object({
  by: Dimension.describe(
    `What to group by: ${Dimension.options.map((d) => `${d} (${DIMENSION_LABEL[d]})`).join(', ')}`,
  ),
  month: Month.optional().describe('A month, YYYY-MM (default: this month to date)'),
  from: Day.optional().describe('First UTC day, YYYY-MM-DD (instead of month)'),
  to: Day.optional().describe('Last UTC day, inclusive'),
  filter: z.array(z.string()).optional().describe('Filters as dimension:value, e.g. ["costCenter:ENG-PLATFORM"]'),
  layer: z
    .enum(['direct', 'spread'])
    .default('direct')
    .describe('direct: the shared pool on its own; spread: shared out'),
  limit: z.number().int().min(1).max(100).default(20),
});

export const BudgetStatusInput = z.object({
  month: Month.optional().describe('A month, YYYY-MM (default: this month)'),
  costCenter: z.string().optional().describe('One cost center code, e.g. ENG-PLATFORM'),
});

export function createMcpServer(spend: Spend, principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'landledger', title: 'Landledger', version: VERSION },
    {
      instructions:
        "Landledger is the land family's cost subledger for technology and AI spend (management reporting; the accounting system stays the book of record). spend_by groups spend by cost center, service, namespace, agent, model and more; budget_status says where each cost center stands against its budget. Amounts are USD strings; every figure is estimated (usage × the internal rate card) or invoiced. Read only: agents request, people decide.",
    },
  );
  const tool = <S extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    run: (args: z.output<S>) => Promise<CallToolResult>,
  ) =>
    server.registerTool(name, { ...config, annotations: { readOnlyHint: true, openWorldHint: false } }, (async (
      args: z.output<S>,
    ) => {
      try {
        requireScope(principal, 'read');
        return await run(args);
      } catch (error) {
        return fail(error);
      }
    }) as never);

  tool(
    'spend_by',
    {
      title: 'Spend by a dimension',
      description:
        "Technology and AI spend for a month (what is booked in it; corrections to locked months on their own line, CORRECTIONS) or a range of days (by the day charged), grouped by one dimension (cost center, service, namespace, agent, model, provider, P&L class, category, resource, workflow, team, product), with each group's estimated and invoiced parts, its share and the window before. Also returns how much is attributed directly versus in the shared pool or unallocated.",
      inputSchema: SpendByInput,
    },
    async (a) => {
      const r = await spend.spend({
        by: a.by,
        month: a.month,
        from: a.from,
        to: a.to,
        filter: a.filter,
        layer: a.layer,
        provisional: 'true',
      });
      const groups = r.groups.slice(0, a.limit);
      const lines = groups.map(
        (g) => `- ${g.label}${g.sub && g.sub !== g.label ? ` (${g.sub})` : ''}: USD ${g.total} (${g.share}%)`,
      );
      const text = [
        `Spend by ${DIMENSION_LABEL[a.by].toLowerCase()}, ${r.from} to ${r.to} (${r.layer}): USD ${r.total.total}, of which USD ${r.total.invoiced} invoiced and USD ${r.total.estimated} estimated${r.total.provisional !== '0.000000' ? ` (USD ${r.total.provisional} provisional, today)` : ''}.`,
        ...lines,
        r.groups.length > groups.length ? `…and ${r.groups.length - groups.length} more.` : '',
        `Attributed directly: ${r.attribution.directShare}% (shared pool USD ${r.attribution.sharedPool}, unallocated USD ${r.attribution.unallocated}).`,
      ]
        .filter(Boolean)
        .join('\n');
      return ok({ ...r, groups, daily: undefined }, text);
    },
  );

  tool(
    'budget_status',
    {
      title: 'Budget status',
      description:
        'Each cost center this month (or the month given) against its budget: month to date (what is booked in the month), forecast to month end, budget, available, variance and state (ok, risk = forecast over budget, over = actual over budget, none = no budget, early = not enough data for a forecast yet). Corrections to locked months are their own line, CORRECTIONS.',
      inputSchema: BudgetStatusInput,
    },
    async (a) => {
      const v = await spend.budgetsView(a.month);
      const rows = a.costCenter ? v.rows.filter((r) => r.code === a.costCenter!.toUpperCase()) : v.rows;
      if (a.costCenter && !rows.length)
        throw new ApiError('not_found', `No spend or budget for ${a.costCenter} in ${v.month}`);
      const state = {
        ok: 'on track',
        risk: 'at risk',
        over: 'over budget',
        none: 'no budget',
        early: 'not enough data yet for a forecast',
      } as const;
      const versions = v.versions.map(
        (i) => `v${i.version}${i.origin === 'dev-seed' ? ' (development seed data)' : ''}`,
      );
      const text = [
        `Budgets for ${v.month}${versions.length ? ` (budget ${versions.join(', ')})` : ' (no budget imported)'}: actual USD ${v.totals.actual} of USD ${v.totals.budget}, forecast ${v.totals.forecast ? `USD ${v.totals.forecast}` : 'not available yet (not enough data)'}.`,
        ...rows.map(
          (r) =>
            `- ${r.name} (${r.code}): ${state[r.state]}; actual USD ${r.monthToDate}${r.budget ? ` of USD ${r.budget}` : ''}${r.forecast ? `, forecast USD ${r.forecast}` : ''}${r.variance ? `, variance USD ${r.variance} (${r.variancePct}%)` : ''}`,
        ),
      ].join('\n');
      return ok({ month: v.month, currency: v.currency, versions: v.versions, totals: v.totals, rows }, text);
    },
  );
  return server;
}
