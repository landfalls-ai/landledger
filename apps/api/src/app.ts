import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import {
  type ApiScope,
  ApiKeyInput,
  BudgetImportInput,
  DIMENSION_LABEL,
  IngestRunInput,
  IngestRunsQuery,
  LockInput,
  Month,
  MonthQuery,
  RecordsQuery,
  SpendQuery,
  WebhookInput,
  AppliedInput,
  SeatReleaseInput,
  CancelInput,
  CreateRequestInput,
  DecisionInput,
  ExceptionsQuery,
  ProposePolicyInput,
  RateCardProposalInput,
  RequestsQuery,
  ReservationsQuery,
  ReserveInput,
  RuleSetProposalInput,
  ConfirmInput,
  CostCenterOwnersInput,
  DeclineInput,
  PersonLinkInput,
  RelayChannelInput,
  SlackRelayInput,
} from '@landledger/contracts';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerAuthRoutes } from './auth.js';
import { ApiError } from './errors.js';
import { evidencePackHtml } from './evidence-pack.js';
import { toCsv, toXlsx, type Sheet } from './export.js';
import { createMcpServer } from './mcp.js';
import { registerScim } from './scim.js';
import { registerWave3 } from './wave3-routes.js';
import { actorOf, identify, type Principal, requireScope, SESSION_COOKIE } from './principal.js';
import type { Services } from './services.js';

import { VERSION } from './version.js';

export { VERSION };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AppOptions {
  logger?: boolean;
  /** A logger to use (main.ts passes the one ingest logs to, so both reach Clickland). */
  loggerInstance?: FastifyBaseLogger;
}

/** Validates a body, query or params object; the first problem becomes a 400 that names its path. */
/** What a re-pricing did, in short. */
export const repricedOf = (runs: readonly { outcome: string; correctedCount: number; newCount: number }[]) => ({
  runs: runs.length,
  failed: runs.filter((r) => r.outcome === 'failed').length,
  corrected: runs.reduce((n, r) => n + r.correctedCount, 0),
  added: runs.reduce((n, r) => n + r.newCount, 0),
});

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ApiError('bad_request', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`, {
    issues: result.error.issues,
  });
}

const Id = z.object({ id: z.string().min(1).max(100) });
const On = z.object({ on: z.iso.date().optional() });
const MonthParam = z.object({ month: Month });
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().min(1).optional(),
});
/** Routes anyone may call; each checks what it needs itself. */
const PUBLIC = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/oidc/callback',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/backchannel-logout',
]);

const today = () => new Date().toISOString().slice(0, 10);

export async function buildApp(services: Services, options: AppOptions = {}): Promise<FastifyInstance> {
  const { config, sql, audit, keys, dimensions, webhooks, periods, records } = services;
  const app = (options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance, bodyLimit: 2 * 1024 * 1024, trustProxy: true })
    : Fastify({
        logger: options.logger ?? false,
        bodyLimit: 2 * 1024 * 1024,
        trustProxy: true,
      })) as unknown as FastifyInstance;
  await app.register(cookie);
  await app.register(cors, { origin: [config.consoleUrl], credentials: true });
  app.decorateRequest('principal', null as unknown as Principal);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.status(error.status).send(error.body());
    const e = error as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500)
      return reply
        .status(e.statusCode)
        .send(new ApiError(e.statusCode === 404 ? 'not_found' : 'bad_request', e.message).body());
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(new ApiError('internal', 'Something went wrong in Landledger').body());
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(new ApiError('not_found', `No route ${request.method} ${request.url.split('?')[0]}`).body()),
  );

  // Who is calling: an API key, else the console's session, else (LANDLEDGER_DEV_AUTH=on) the local developer.
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    const principal = await identify(sql, config, {
      authorization: request.headers.authorization,
      sessionToken: request.cookies[SESSION_COOKIE],
    });
    if (!principal) throw new ApiError('unauthorized', 'Sign in with Landbright, or send an API key');
    request.principal = principal;
  });
  const need = (request: FastifyRequest, scope: ApiScope) => requireScope(request.principal, scope);

  registerAuthRoutes(app, { sql, config, sessions: services.sessions });

  app.get('/api/health', async (_request, reply) => {
    let postgres = 'ok';
    let migrations = 0;
    try {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM _migrations`;
      migrations = row!.n;
    } catch (e) {
      postgres = e instanceof Error ? e.message : 'down';
    }
    const status = postgres === 'ok' ? 'ok' : 'degraded';
    return reply.status(status === 'ok' ? 200 : 503).send({ status, postgres, migrations, version: VERSION });
  });

  // Dimensions and rate cards (read only until the requests of wave 2) -----------------------------------------------
  const on = (r: FastifyRequest) => parse(On, r.query).on ?? today();
  app.get('/api/cost-centers', async (r) => (need(r, 'read'), { costCenters: await dimensions.costCenters(on(r)) }));
  app.get('/api/teams', async (r) => (need(r, 'read'), { teams: await dimensions.teams(on(r)) }));
  app.get('/api/products', async (r) => (need(r, 'read'), { products: await dimensions.products(on(r)) }));
  app.get('/api/rate-cards', async (r) => (need(r, 'read'), { rateCards: await dimensions.rateCards(on(r)) }));
  app.get('/api/rate-cards/:id', async (r) => (need(r, 'read'), dimensions.rateCard(parse(Id, r.params).id, on(r))));

  // The ledger (spec 001): months and cost records ------------------------------------------------------------------
  app.get('/api/periods', async (r) => (need(r, 'read'), { periods: await periods.list() }));
  app.post('/api/periods/:month/close', async (r) => {
    need(r, 'admin');
    return periods.advance(parse(MonthParam, r.params).month, 'closing', r.principal);
  });
  app.post('/api/periods/:month/lock', async (r) => {
    need(r, 'admin');
    const { override } = parse(LockInput, r.body ?? {});
    return periods.advance(parse(MonthParam, r.params).month, 'locked', r.principal, override);
  });
  app.get('/api/records', async (r) => (need(r, 'read'), records.list(parse(RecordsQuery, r.query))));

  // The audit log ---------------------------------------------------------------------------------------------------
  app.get('/api/audit', async (r) => (need(r, 'read'), audit.list(parse(AuditQuery, r.query))));
  app.get('/api/audit/verify', async (r) => (need(r, 'read'), audit.verify()));

  // API keys: only a signed-in admin person mints one (the bootstrap key only until the first admin person exists) ----
  app.get('/api/keys', async (r) => (need(r, 'admin'), { keys: await keys.list() }));
  app.post('/api/keys', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await keys.create(parse(ApiKeyInput, r.body), r.principal));
  });
  app.delete('/api/keys/:id', async (r, reply) => {
    need(r, 'admin');
    await keys.revoke(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });

  // SCIM tokens (Landbright's push, /scim/v2) ---------------------------------------------------------------------------
  const ScimTokenInput = z.object({ name: z.string().trim().min(1).max(100) });
  const person = (r: FastifyRequest, what: string) => {
    if (r.principal.kind !== 'person' && r.principal.kind !== 'dev')
      throw new ApiError('forbidden', `A person ${what}; an API key never does`);
  };
  app.get('/api/scim/tokens', async (r) => (need(r, 'admin'), { tokens: await services.scimTokens.list() }));
  app.post('/api/scim/tokens', async (r, reply) => {
    need(r, 'admin');
    person(r, 'mints a SCIM token');
    const { name } = parse(ScimTokenInput, r.body);
    return reply.status(201).send(await services.scimTokens.create(name, actorOf(r.principal)));
  });
  app.delete('/api/scim/tokens/:id', async (r, reply) => {
    need(r, 'admin');
    person(r, 'revokes a SCIM token');
    await services.scimTokens.revoke(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });
  await registerScim(app, services.scim, services.scimTokens);

  // Webhooks out: a `webhooks:write` key manages its own subscriptions; an admin person all of them ------------------
  const hooks = (r: FastifyRequest) =>
    need(r, r.principal.kind === 'key' && !r.principal.scopes.includes('admin') ? 'webhooks:write' : 'admin');
  app.get('/api/webhooks', async (r) => (hooks(r), { webhooks: await webhooks.list(r.principal) }));
  app.post('/api/webhooks', async (r, reply) => {
    hooks(r);
    return reply.status(201).send(await webhooks.create(parse(WebhookInput, r.body), r.principal));
  });
  app.delete('/api/webhooks/:id', async (r, reply) => {
    hooks(r);
    await webhooks.delete(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });
  app.get('/api/webhooks/:id/deliveries', async (r) => {
    hooks(r);
    const id = parse(Id, r.params).id;
    await webhooks.own(id, r.principal);
    return { deliveries: await webhooks.deliveries(id) };
  });
  /** Sends a `ping` to one webhook through the outbox, to check the receiver and its signature check. */
  app.post('/api/webhooks/:id/ping', async (r, reply) => {
    hooks(r);
    const id = parse(Id, r.params).id;
    await webhooks.own(id, r.principal);
    const result = await sql.begin((tx) => webhooks.enqueue(tx, 'ping', { webhookId: id }, id));
    if (result.deliveries === 0) throw new ApiError('not_found', 'Webhook not found, or it takes no ping');
    return reply.status(202).send(result);
  });

  // Ingest (spec 002) ------------------------------------------------------------------------------------------------
  const { ingest, rateCards, allocation, budgets, spend } = services;
  app.get(
    '/api/ingest/runs',
    async (r) => (need(r, 'read'), { runs: await ingest.list(parse(IngestRunsQuery, r.query)) }),
  );
  app.post('/api/ingest/run', async (r, reply) => {
    need(r, 'ingest');
    const input = parse(IngestRunInput, r.body);
    const day = input.day ?? today();
    const sources = input.source === 'all' ? ingest.sources() : [input.source];
    if (!sources.length)
      throw new ApiError('unavailable', 'No source is configured (LANDLEDGER_LANDFLOW_* or LANDLEDGER_CLICKLAND_*)');
    const by = r.principal.email ?? r.principal.name;
    const runs = [];
    if (input.force && r.principal.kind !== 'person' && r.principal.kind !== 'dev')
      throw new ApiError('forbidden', 'A person forces a run (it may reverse a whole day); an API key never does');
    for (const s of sources)
      runs.push(await ingest.run(s, day, 'manual', by, { force: input.force, reason: input.reason }));
    return reply.status(201).send({ runs });
  });

  // Rate cards: approval (people only) and the AI lines from Landflow's price table ---------------------------------
  const VersionId = z.object({ id: z.string().min(1).max(100) });
  // Approving a version is a request now (wave 2): the route answers 409 with the version's request to decide.
  // Raising it is a write: a signed-in person with requests:write; read and auditor get 403, and the audit names the caller.
  const foldedIntoRequests = (type: 'rate_card_version' | 'rule_set_version') => async (r: FastifyRequest) => {
    need(r, 'requests:write');
    if (r.principal.kind !== 'person')
      throw new ApiError(
        'forbidden',
        "A person signed in with Landbright raises a version's request; an API key doesn't",
      );
    const requestId = await services.proposals.requestForVersion(type, parse(VersionId, r.params).id, r.principal);
    throw new ApiError(
      'conflict',
      `Approving a ${type === 'rate_card_version' ? 'rate card' : 'rule set'} version is a request now: decide request ${requestId} with POST /api/requests/${requestId}/decisions`,
      { requestId },
    );
  };
  app.post('/api/rate-cards/versions/:id/approve', foldedIntoRequests('rate_card_version'));
  app.post('/api/rate-cards/versions/:id/ai-lines', async (r, reply) => {
    need(r, 'admin');
    if (!services.landflow) throw new ApiError('unavailable', 'Landflow is not configured');
    const added = await rateCards.importAiLines(
      parse(VersionId, r.params).id,
      await services.landflow.prices(),
      r.principal,
    );
    return reply.status(201).send({ added });
  });

  // Allocation (spec 003) ----------------------------------------------------------------------------------------------
  app.get('/api/allocation/rule-sets', async (r) => (need(r, 'read'), { versions: await allocation.versions() }));
  app.post('/api/allocation/rule-sets/versions/:id/approve', foldedIntoRequests('rule_set_version'));
  app.post('/api/allocation/rebuild/:month', async (r, reply) => {
    need(r, 'admin');
    if (r.principal.kind !== 'person' && r.principal.kind !== 'dev')
      throw new ApiError('forbidden', 'A person rebuilds allocations; an API key never does');
    const month = parse(MonthParam, r.params).month;
    return reply.status(201).send(await allocation.rebuild(month, 'rebuilt by hand', actorOf(r.principal)));
  });

  // Budgets (spec 003) -------------------------------------------------------------------------------------------------
  app.get('/api/budgets', async (r) => (need(r, 'read'), spend.budgetsView(parse(MonthQuery, r.query).month)));
  app.post('/api/budgets/import', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await budgets.import(parse(BudgetImportInput, r.body), r.principal));
  });

  // Spend: Overview, Explore and exports -------------------------------------------------------------------------------
  app.get('/api/overview', async (r) => (need(r, 'read'), spend.overview(parse(MonthQuery, r.query).month)));
  app.get('/api/spend', async (r) => (need(r, 'read'), spend.spend(parse(SpendQuery, r.query))));
  const ExportQuery = SpendQuery.extend({ format: z.enum(['csv', 'xlsx']).default('csv') });
  app.get('/api/spend/export', async (r, reply) => {
    need(r, 'read');
    const q = parse(ExportQuery, r.query);
    const res = await spend.spend(q);
    const label = DIMENSION_LABEL[res.by];
    const n = (s: string | null) => (s === null ? '' : { number: s });
    const groups: Sheet = {
      name: `By ${label.toLowerCase()}`,
      header: [
        label,
        'Detail',
        'Estimated (USD)',
        'Invoiced (USD)',
        'Total (USD)',
        'Share (%)',
        'Window before (USD)',
        'Provisional (USD)',
      ],
      rows: res.groups.map((g) => [
        g.label,
        g.sub ?? '',
        n(g.estimated),
        n(g.invoiced),
        n(g.total),
        n(g.share),
        n(g.previous),
        n(g.provisional),
      ]),
    };
    groups.rows.push([
      'Total',
      '',
      n(res.total.estimated),
      n(res.total.invoiced),
      n(res.total.total),
      { number: '100.0' },
      n(res.total.previous),
      n(res.total.provisional),
    ]);
    const daily: Sheet = {
      name: 'Daily',
      header: ['Day', ...res.daily.series.map((s) => s.label)],
      rows: res.daily.days.map((d, i) => [d, ...res.daily.series.map((s) => ({ number: s.values[i]! }))]),
    };
    const name = `landledger-spend-${res.by}-${res.from}-to-${res.to}${res.layer === 'spread' ? '-spread' : ''}`;
    if (q.format === 'xlsx')
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${name}.xlsx"`)
        .send(toXlsx([groups, daily]));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}.csv"`)
      .send(toCsv(groups));
  });

  // Requests, decisions, reservations, policies, proposals, exceptions (wave 2, spec 004) ------------------------------
  const { requests, reservations, policies, proposals, exceptions } = services;
  const Sha = z.object({ id: z.string().min(1).max(100), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
  const ReleaseInput = z.object({ reason: z.string().trim().max(1000).default('') });
  const viaOf = (r: FastifyRequest) => (r.principal.kind === 'person' ? 'session' : 'key') as 'session' | 'key';
  const EvidencePackQuery = z.object({ format: z.enum(['json', 'html']).default('json') });
  const CodeParam = z.object({ code: z.string().min(1).max(100) });
  const aPerson = (r: FastifyRequest, what: string) => {
    if (r.principal.kind !== 'person')
      throw new ApiError(
        'forbidden',
        `A person signed in with Landbright ${what}; an API key or the local developer doesn't`,
      );
  };
  app.get('/api/requests', async (r) => (need(r, 'read'), requests.list(parse(RequestsQuery, r.query), r.principal)));
  app.post('/api/requests', async (r, reply) => {
    need(r, 'requests:write');
    const { request, created } = await requests.create(parse(CreateRequestInput, r.body), r.principal, viaOf(r));
    return reply.status(created ? 201 : 200).send({ request });
  });
  app.get('/api/requests/:id', async (r) => (need(r, 'read'), requests.detail(parse(Id, r.params).id, r.principal)));
  app.get('/api/requests/:id/evidence/:sha256', async (r) => {
    need(r, 'read');
    const { id, sha256 } = parse(Sha, r.params);
    return requests.storedSnapshot(id, sha256);
  });
  app.get('/api/requests/:id/evidence-pack', async (r, reply) => {
    need(r, 'read');
    const pack = await requests.evidencePack(parse(Id, r.params).id, r.principal);
    if (parse(EvidencePackQuery, r.query).format === 'html')
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .send(evidencePackHtml(pack));
    return pack;
  });
  // Confirmation: a request a key raised naming a person waits for that person, in their own session.
  app.post('/api/requests/:id/confirm', async (r) => {
    need(r, 'read');
    const { comment } = parse(ConfirmInput, r.body ?? {});
    return { request: await requests.confirm(parse(Id, r.params).id, comment, r.principal) };
  });
  app.post('/api/requests/:id/decline', async (r) => {
    need(r, 'read');
    const { reason } = parse(DeclineInput, r.body ?? {});
    return { request: await requests.decline(parse(Id, r.params).id, reason, r.principal) };
  });
  app.get(
    '/api/requests/:id/decisions',
    async (r) => (need(r, 'read'), { decisions: await requests.decisions(parse(Id, r.params).id) }),
  );
  app.post('/api/requests/:id/submit', async (r) => {
    need(r, 'requests:write');
    return { request: await requests.submit(parse(Id, r.params).id, r.principal) };
  });
  app.post('/api/requests/:id/cancel', async (r) => {
    need(r, 'requests:write');
    const { reason } = parse(CancelInput, r.body ?? {});
    return { request: await requests.cancel(parse(Id, r.params).id, reason, r.principal) };
  });
  // A decision is a person's, from their own session (Requests.decide refuses keys: relays use /api/relays/slack).
  app.post('/api/requests/:id/decisions', async (r, reply) => {
    need(r, 'read');
    return reply
      .status(201)
      .send(await requests.decide(parse(Id, r.params).id, parse(DecisionInput, r.body), r.principal));
  });
  // A relay: the raw Slack interaction; Landledger verifies it and decides as the person who linked that Slack user.
  app.post('/api/relays/slack', async (r, reply) => {
    need(r, 'decisions:relay');
    return reply.status(201).send(await requests.relay(parse(SlackRelayInput, r.body), r.principal));
  });
  app.get('/api/relay-channels', async (r) => {
    need(r, 'admin');
    aPerson(r, 'manages relay channels');
    return { channels: await services.relayChannels.list() };
  });
  app.post('/api/relay-channels', async (r, reply) => {
    need(r, 'admin');
    aPerson(r, 'registers a relay channel');
    return reply.status(201).send(await services.relayChannels.create(parse(RelayChannelInput, r.body), r.principal));
  });
  app.delete('/api/relay-channels/:id', async (r, reply) => {
    need(r, 'admin');
    aPerson(r, 'disables a relay channel');
    await services.relayChannels.disable(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });
  app.get('/api/me/links', async (r) => (need(r, 'read'), { links: await services.links.list(r.principal) }));
  app.post('/api/me/links', async (r, reply) => {
    need(r, 'read');
    return reply.status(201).send(await services.links.create(parse(PersonLinkInput, r.body), r.principal));
  });
  app.delete('/api/me/links/:id', async (r, reply) => {
    need(r, 'read');
    await services.links.remove(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });
  app.get('/api/cost-centers/:code/owners', async (r) => {
    need(r, 'read');
    return services.owners.view(parse(CodeParam, r.params).code);
  });
  app.put('/api/cost-centers/:code/owners', async (r) => {
    need(r, 'admin');
    aPerson(r, 'maps cost center owners');
    return services.owners.set(parse(CodeParam, r.params).code, parse(CostCenterOwnersInput, r.body), r.principal);
  });
  app.post('/api/requests/:id/applied', async (r) => {
    need(r, 'requests:write');
    return { request: await requests.applied(parse(Id, r.params).id, parse(AppliedInput, r.body ?? {}), r.principal) };
  });
  // Spec 010 (review of wave 3): cost approved but access denied, or a grant revoked: the seat goes back.
  app.post('/api/requests/:id/seats/release', async (r) => {
    need(r, 'requests:write');
    return {
      request: await requests.releaseSeats(parse(Id, r.params).id, parse(SeatReleaseInput, r.body), r.principal),
    };
  });

  app.get(
    '/api/reservations',
    async (r) => (need(r, 'read'), { reservations: await reservations.list(parse(ReservationsQuery, r.query)) }),
  );
  app.post('/api/reservations', async (r, reply) => {
    need(r, 'reservations:write');
    const { reservation, created } = await reservations.reserve(parse(ReserveInput, r.body), r.principal);
    return reply.status(created ? 201 : 200).send({ reservation });
  });
  // Release: the key that raised the request, its requester or sponsor, or an admin person (Reservations.release).
  app.post('/api/reservations/:id/release', async (r) => {
    need(r, r.principal.kind === 'person' ? 'read' : 'reservations:write');
    const { reason } = parse(ReleaseInput, r.body ?? {});
    return { reservation: await reservations.release(parse(Id, r.params).id, reason, r.principal) };
  });

  app.get('/api/policies', async (r) => (need(r, 'read'), { policies: await policies.list() }));
  app.post('/api/policies', async (r, reply) => {
    need(r, 'requests:write');
    aPerson(r, 'proposes a policy');
    return reply
      .status(201)
      .send(await proposals.proposePolicy(parse(ProposePolicyInput, r.body), policies, r.principal));
  });

  const RatePreview = RateCardProposalInput.pick({ effectiveFrom: true, changes: true });
  const RulesPreview = RuleSetProposalInput.pick({ effectiveFrom: true, rules: true, shares: true });
  app.post('/api/rate-cards/proposals/preview', async (r) => {
    need(r, 'read');
    return proposals.previewRateCard(parse(RatePreview, r.body));
  });
  app.post('/api/rate-cards/proposals', async (r, reply) => {
    need(r, 'requests:write');
    aPerson(r, 'proposes a rate card');
    return reply.status(201).send(await proposals.proposeRateCard(parse(RateCardProposalInput, r.body), r.principal));
  });
  app.post('/api/allocation/rule-sets/proposals/preview', async (r) => {
    need(r, 'read');
    return proposals.previewRuleSet(parse(RulesPreview, r.body));
  });
  app.post('/api/allocation/rule-sets/proposals', async (r, reply) => {
    need(r, 'requests:write');
    aPerson(r, 'proposes allocation rules');
    return reply.status(201).send(await proposals.proposeRuleSet(parse(RuleSetProposalInput, r.body), r.principal));
  });

  app.get('/api/exceptions', async (r) => (need(r, 'read'), exceptions.report(parse(ExceptionsQuery, r.query))));
  const ReportsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });
  app.get(
    '/api/exceptions/reports',
    async (r) => (need(r, 'read'), { reports: await exceptions.reports(parse(ReportsQuery, r.query).limit) }),
  );
  app.get(
    '/api/exceptions/reports/:id',
    async (r) => (need(r, 'read'), exceptions.storedReport(parse(Id, r.params).id)),
  );

  // MCP (stateless Streamable HTTP, Clickland's pattern): spend_by and budget_status -------------------------------------
  app.post('/api/mcp', async (request, reply) => {
    need(request, 'read');
    const server = createMcpServer(services, request.principal);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const noSessions = async (_r: FastifyRequest, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Landledger’s MCP server is stateless: POST only' },
      id: null,
    });
  app.get('/api/mcp', noSessions);
  app.delete('/api/mcp', noSessions);

  registerWave3(app, services, need);
  return app;
}
