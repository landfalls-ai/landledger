/**
 * Landledger's MCP server (specs 002–004): stateless Streamable HTTP at `POST /api/mcp`, Clickland's pattern — one
 * server per request, bound to the caller (a key with `read`, or a signed-in person). Read tools: `spend_by`,
 * `budget_status`, `list_requests`, `get_request`. Write tools: `create_request` (`requests:write`; an agent always
 * with a sponsor, a person) and `reserve` (`reservations:write`). **There is no tool that decides**: agents request,
 * people decide. Amounts are decimal strings in USD.
 */
import {
  AgentRef,
  CreateRequestInput,
  Dimension,
  DIMENSION_LABEL,
  PersonRef,
  RequestBox,
  RequestKind,
} from '@landledger/contracts';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION } from './version.js';
import { ApiError } from './errors.js';
import { type Principal, requireScope } from './principal.js';
import type { Services } from './services.js';

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

export const ListRequestsInput = z.object({
  box: RequestBox.default('all').describe('waiting (on the caller), mine (raised or sponsored), decided, open, all'),
  kind: RequestKind.optional(),
  costCenter: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const GetRequestInput = z.object({ id: z.string().describe('The request id (req_…)') });
export const CreateRequestTool = z.object({
  kind: z.enum(['infra_change', 'ai_budget', 'tool_or_seat', 'other']),
  title: z.string().min(3).max(200),
  note: z.string().max(4000).default('').describe('Why, in the requester’s words'),
  costCenter: z.string().describe('A cost center code, e.g. ENG-PLATFORM'),
  amount: z.string().describe('USD in major units, e.g. "1840.00"'),
  recurrence: z.enum(['monthly', 'once']),
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  evidence: z.record(z.string(), z.unknown()).default({}).describe('lines, basis, links, match (a selector)'),
  agent: AgentRef.optional().describe('The agent asking; then sponsor is required'),
  sponsor: PersonRef.optional().describe('The person who answers for the agent (Landbright sub or email)'),
  person: PersonRef.optional().describe('Or: the person asking, when no agent is'),
  idempotencyKey: z.string().max(200).optional(),
});
export const ReserveTool = z.object({
  requestId: z.string(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  amount: z.string().optional().describe('USD; at most what the request adds in the month'),
});

export function createMcpServer(services: Services, principal: Principal): McpServer {
  const { spend, requests, reservations } = services;
  const server = new McpServer(
    { name: 'landledger', title: 'Landledger', version: VERSION },
    {
      instructions:
        "Landledger is the land family's cost subledger for technology and AI spend (management reporting; the accounting system stays the book of record). spend_by groups spend by cost center, service, namespace, agent, model and more; budget_status says where each cost center stands against its budget. list_requests and get_request read spend requests and their approval path; create_request raises one (an agent always names its sponsor, a person); reserve holds budget for an approved request. Amounts are USD strings. Agents request; people decide: no tool approves or rejects.",
    },
  );
  const tool = <S extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    run: (args: z.output<S>) => Promise<CallToolResult>,
    scope: 'read' | 'requests:write' | 'reservations:write' = 'read',
  ) =>
    server.registerTool(
      name,
      { ...config, annotations: { readOnlyHint: scope === 'read', destructiveHint: false, openWorldHint: false } },
      (async (args: z.output<S>) => {
        try {
          requireScope(principal, scope);
          return await run(args);
        } catch (error) {
          return fail(error);
        }
      }) as never,
    );

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
  const usd = (a: string) => `USD ${a}`;
  tool(
    'list_requests',
    {
      title: 'List spend requests',
      description:
        'Spend requests (infra changes, AI budgets, tools or seats, rate card, rule set and policy changes) with their status, the step they wait on, the amount and the budget left after them. box: waiting (on the caller), mine (raised or sponsored), decided, open, all.',
      inputSchema: ListRequestsInput,
    },
    async (a) => {
      const r = await requests.list({ box: a.box, kind: a.kind, costCenter: a.costCenter, limit: a.limit }, principal);
      const text = [
        `${r.requests.length} request(s) (${a.box}); open ${r.counts.open}, waiting on you ${r.counts.waiting}.`,
        ...r.requests.map(
          (q) =>
            `- ${q.number} ${q.title} (${q.costCenter.code}): ${usd(q.amount.amount)} ${q.recurrence === 'monthly' ? 'a month' : 'once'}; ${q.stepLabel}`,
        ),
      ].join('\n');
      return ok(r, text);
    },
  );
  tool(
    'get_request',
    {
      title: 'Get a spend request',
      description:
        "One request with its steps (who may decide each), decisions, reservations and Landledger's evidence (budget, actual, reserved, left now and after, forecast, why this path). A person decides in the Landledger console, or in a relay channel they linked themselves to; this tool never decides.",
      inputSchema: GetRequestInput,
    },
    async (a) => {
      const d = await requests.detail(a.id, principal);
      const q = d.request;
      const text = [
        `${q.number} ${q.title}: ${q.status}. ${usd(q.amount.amount)} ${q.recurrence === 'monthly' ? 'a month' : 'once'} for ${q.costCenter.code}.`,
        `Why this path: ${d.evidence.why}`,
        ...q.steps.map(
          (s) =>
            `- Step ${s.position} ${s.label}: ${s.status}${s.decision ? ` by ${s.decision.person.name}` : s.status === 'pending' ? ` (approvers: ${s.approvers.people.map((p) => p.name).join(', ') || s.approvers.groups.join(' or ')})` : ''}`,
        ),
        `Budget ${d.evidence.budget ? usd(d.evidence.budget) : 'none'}; left now ${d.evidence.leftNow ? usd(d.evidence.leftNow) : '—'}, after ${d.evidence.leftAfter ? usd(d.evidence.leftAfter) : '—'}.`,
      ].join('\n');
      return ok(d, text);
    },
  );
  tool(
    'create_request',
    {
      title: 'Raise a spend request',
      description:
        'Raises a spend request for a person to decide. An agent names itself (agent) and its sponsor, the person who answers for it; or name the person asking. From a key, that person first confirms it in the Landledger console (status awaiting_confirmation). Then, below the policy threshold (counting what policy approved this month), it is approved by policy and reserved; otherwise it waits on the budget owner, Finance or the CFO. Its origin is always mcp. Returns the request and its path.',
      inputSchema: CreateRequestTool,
    },
    async (a) => {
      const requester = a.agent
        ? a.sponsor
          ? { kind: 'agent' as const, agent: a.agent, sponsor: a.sponsor }
          : (() => {
              throw new ApiError('bad_request', 'An agent names its sponsor: the person who answers for it');
            })()
        : a.person
          ? { kind: 'person' as const, person: a.person }
          : undefined;
      const input = CreateRequestInput.parse({
        kind: a.kind,
        title: a.title,
        note: a.note,
        costCenter: a.costCenter,
        amount: { amount: a.amount, currency: 'USD' },
        recurrence: a.recurrence,
        start: a.start,
        end: a.end,
        evidence: a.evidence,
        // Always mcp, stamped with the caller (createdBy): MCP can't say where a request came from.
        origin: { type: 'mcp' },
        requester,
        idempotencyKey: a.idempotencyKey,
      });
      const { request: q, created } = await requests.create(input, principal, 'mcp');
      return ok(
        { request: q, created },
        `${created ? 'Raised' : 'Already raised'} ${q.number} ${q.title}: ${q.status}${q.automatic ? ' (approved by policy)' : ''}. ${q.policy?.reason ?? ''}`,
      );
    },
    'requests:write',
  );
  tool(
    'reserve',
    {
      title: 'Reserve budget for an approved request',
      description:
        "Reserves a month of an approved request's window (approval already reserves its first months), at most what it adds in that month. Idempotent per month.",
      inputSchema: ReserveTool,
    },
    async (a) => {
      const { reservation, created } = await reservations.reserve(a, principal);
      return ok(
        { reservation, created },
        `${created ? 'Reserved' : 'Already reserved'} ${usd(reservation.amount)} for ${reservation.costCenter} in ${reservation.month} (${reservation.status}).`,
      );
    },
    'reservations:write',
  );
  return server;
}
