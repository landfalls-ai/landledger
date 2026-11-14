import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { type ApiScope, ApiKeyInput, Month, RecordsQuery, WebhookInput } from '@landledger/contracts';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerAuthRoutes } from './auth.js';
import { ApiError } from './errors.js';
import { identify, type Principal, requireScope, SESSION_COOKIE } from './principal.js';
import type { Services } from './services.js';

export const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AppOptions {
  logger?: boolean;
}

/** Validates a body, query or params object; the first problem becomes a 400 that names its path. */
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
]);

const today = () => new Date().toISOString().slice(0, 10);

export async function buildApp(services: Services, options: AppOptions = {}): Promise<FastifyInstance> {
  const { config, sql, audit, keys, dimensions, webhooks, periods, records } = services;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: true });
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
    return periods.advance(parse(MonthParam, r.params).month, 'locked', r.principal);
  });
  app.get('/api/records', async (r) => (need(r, 'read'), records.list(parse(RecordsQuery, r.query))));

  // The audit log ---------------------------------------------------------------------------------------------------
  app.get('/api/audit', async (r) => (need(r, 'read'), audit.list(parse(AuditQuery, r.query))));
  app.get('/api/audit/verify', async (r) => (need(r, 'read'), audit.verify()));

  // API keys --------------------------------------------------------------------------------------------------------
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

  // Webhooks out ----------------------------------------------------------------------------------------------------
  app.get('/api/webhooks', async (r) => (need(r, 'admin'), { webhooks: await webhooks.list() }));
  app.post('/api/webhooks', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await webhooks.create(parse(WebhookInput, r.body), r.principal));
  });
  app.delete('/api/webhooks/:id', async (r, reply) => {
    need(r, 'admin');
    await webhooks.delete(parse(Id, r.params).id, r.principal);
    return reply.status(204).send();
  });
  app.get(
    '/api/webhooks/:id/deliveries',
    async (r) => (need(r, 'admin'), { deliveries: await webhooks.deliveries(parse(Id, r.params).id) }),
  );
  /** Sends a `ping` to one webhook through the outbox, to check the receiver and its signature check. */
  app.post('/api/webhooks/:id/ping', async (r, reply) => {
    need(r, 'admin');
    const id = parse(Id, r.params).id;
    const result = await sql.begin((tx) => webhooks.enqueue(tx, 'ping', { webhookId: id }, id));
    if (result.deliveries === 0) throw new ApiError('not_found', 'Webhook not found, or it takes no ping');
    return reply.status(202).send(result);
  });

  return app;
}
