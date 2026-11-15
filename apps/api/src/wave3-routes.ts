/**
 * Wave 3's routes, "Plan and reconcile" (specs 005–011): invoices and reconciliation, the year ahead, anomalies,
 * agents, contracts and seats, the access review. Each route checks its scope; what only a person may do is checked
 * again by its service (a key never imports, attests or acknowledges).
 */
import {
  AcknowledgeInput,
  AgentsQuery,
  ContractImportInput,
  AnomaliesQuery,
  AttestInput,
  type ApiScope,
  ForecastQuery,
  InvoiceImportInput,
  InvoiceVoidInput,
  ReconciliationQuery,
} from '@landledger/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from './app.js';
import { notFound } from './errors.js';
import { yearAhead } from './forecast.js';
import type { Services } from './services.js';

const Id = z.object({ id: z.string().min(1).max(100) });

export function registerWave3(
  app: FastifyInstance,
  services: Services,
  need: (r: FastifyRequest, scope: ApiScope) => void,
) {
  const { invoices, sql } = services;

  // 005 Invoices and reconciliation ----------------------------------------------------------------------------------
  app.get('/api/invoices', async (r) => {
    need(r, 'read');
    const month = parse(ReconciliationQuery, r.query).month ?? new Date().toISOString().slice(0, 7);
    return { month, invoices: await invoices.list(month) };
  });
  app.get('/api/invoices/:id', async (r) => (need(r, 'read'), invoices.view(parse(Id, r.params).id)));
  app.post('/api/invoices/import', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await invoices.import(parse(InvoiceImportInput, r.body), r.principal));
  });
  app.post('/api/invoices/:id/void', async (r) => {
    need(r, 'admin');
    return invoices.void(parse(Id, r.params).id, parse(InvoiceVoidInput, r.body).reason, r.principal);
  });
  app.get('/api/reconciliation', async (r) => {
    need(r, 'read');
    return invoices.reconciliation(parse(ReconciliationQuery, r.query).month);
  });
  app.get('/api/requests/:id/lifecycle', async (r) => {
    need(r, 'read');
    const [row] = await sql<Parameters<typeof invoices.lifecycle>[0][]>`
      SELECT id, title, status, amount_micros::text AS amount_micros, currency, recurrence, start_day, end_day,
             decided_at, closed_by, cost_center, evidence, automatic
      FROM requests WHERE id = ${parse(Id, r.params).id}`;
    if (!row) throw notFound('Request');
    return { lifecycle: await invoices.lifecycle(row) };
  });

  // 006 Forecasts ------------------------------------------------------------------------------------------------------
  app.get('/api/forecast', async (r) => {
    need(r, 'read');
    return yearAhead(sql, services.spend, services.spend.today(), parse(ForecastQuery, r.query).months);
  });

  // 007 Anomalies ------------------------------------------------------------------------------------------------------
  app.get('/api/anomalies', async (r) => {
    need(r, 'read');
    return { anomalies: await services.anomalies.list(parse(AnomaliesQuery, r.query)) };
  });
  app.get('/api/anomalies/:id', async (r) => (need(r, 'read'), services.anomalies.view(parse(Id, r.params).id)));
  app.post('/api/anomalies/:id/acknowledge', async (r) => {
    need(r, 'requests:write');
    return services.anomalies.acknowledge(parse(Id, r.params).id, parse(AcknowledgeInput, r.body).note, r.principal);
  });
  app.post('/api/anomalies/scan', async (r) => {
    need(r, 'admin');
    return services.anomalies.scan();
  });

  // 008 Agents ---------------------------------------------------------------------------------------------------------
  app.get('/api/agents', async (r) => {
    need(r, 'read');
    return services.agents.view(parse(AgentsQuery, r.query).month);
  });

  // 009 Contracts and 010 seats ------------------------------------------------------------------------------------------
  const SeatsQuery = z.object({ landbrightApp: z.string().trim().min(1).max(200) });
  app.get('/api/contracts', async (r) => (need(r, 'read'), services.contracts.list()));
  app.get('/api/contracts/seats', async (r) => {
    need(r, 'read');
    return services.contracts.seatsFor(parse(SeatsQuery, r.query).landbrightApp);
  });
  app.get('/api/contracts/:id', async (r) => (need(r, 'read'), services.contracts.view(parse(Id, r.params).id)));
  app.post('/api/contracts/import', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await services.contracts.import(parse(ContractImportInput, r.body), r.principal));
  });

  // 011 Access review --------------------------------------------------------------------------------------------------
  const ItemParams = z.object({ id: z.string().min(1).max(100), itemId: z.string().min(1).max(100) });
  app.get('/api/access-reviews', async (r) => (need(r, 'read'), services.accessReviews.list()));
  app.get(
    '/api/access-reviews/:id',
    async (r) => (need(r, 'read'), services.accessReviews.view(parse(Id, r.params).id)),
  );
  app.post('/api/access-reviews', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await services.accessReviews.open(r.principal));
  });
  app.post('/api/access-reviews/:id/items/:itemId/attest', async (r) => {
    need(r, 'admin');
    const p = parse(ItemParams, r.params);
    return services.accessReviews.attest(p.id, p.itemId, parse(AttestInput, r.body), r.principal);
  });
}
