/**
 * Wave 4's routes, "Month-end" (specs 012–019): the close and its four-eyes lock, accruals, the stored forecast,
 * variance notes, the frozen snapshot, Datarails, the month-end package and the cost of a window. Each route checks its
 * scope; what only a person may do is checked again by its service (a key never closes, accepts or locks).
 */
import {
  AccrualAcceptInput,
  AccrualProposeInput,
  type ApiScope,
  CloseExplainInput,
  CloseStartInput,
  CoaMappingProposeInput,
  CostWindowQuery,
  DatarailsPullDecideInput,
  DatarailsPullInput,
  DatarailsPullRejectInput,
  DatarailsUploadInput,
  LockSignInput,
  NoteAcceptInput,
  NoteDraftInput,
  NoteRejectInput,
  NoteTemplateInput,
  ReopenInput,
} from '@landledger/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from './app.js';
import { localParts } from './business-hours.js';
import { costWindow } from './cost-window.js';
import { ApiError, notFound } from './errors.js';
import { TOTAL } from './forecast-history.js';
import { requireScope } from './principal.js';
import type { Services } from './services.js';

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM');
const MonthParam = z.object({ month: Month });
const MonthQuery = z.object({ month: Month.optional() });
const Id = z.object({ id: z.string().min(1).max(100) });
const PackageQuery = z.object({ format: z.enum(['json', 'html']).default('json') });
const HistoryQuery = z.object({ month: Month.optional(), costCenter: z.string().trim().min(1).max(50).default(TOTAL) });

/** The month a page means when it names none: the last month that ended, in LANDLEDGER_TZ (review of wave 4, nit). */
export const lastEnded = (now: Date, timeZone = 'UTC') => {
  const [y, m] = localParts(now.getTime(), timeZone).date.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export function registerWave4(
  app: FastifyInstance,
  services: Services,
  need: (r: FastifyRequest, scope: ApiScope) => void,
) {
  const { now } = services;
  const { close, accruals, journal, notes, snapshots, datarails, packages, forecastHistory, requests } = services;
  const monthOf = (r: FastifyRequest) => parse(MonthQuery, r.query).month ?? lastEnded(now(), services.config.timeZone);

  // 012 The close ------------------------------------------------------------------------------------------------------
  // Review of wave 4 (should-fix 1): each time a person is served the month's snapshot (the close page, the snapshot,
  // the package) is recorded: a signature needs its signer to have been shown what they sign.
  app.get('/api/close', async (r) => {
    need(r, 'read');
    const month = monthOf(r);
    await close.served(month, r.principal);
    return close.view(month);
  });
  app.post('/api/close/:month/start', async (r) => {
    // A controller, the CFO or FP&A (the service checks the role; review of wave 4: FP&A starts the close).
    need(r, 'requests:write');
    return close.start(parse(MonthParam, r.params).month, parse(CloseStartInput, r.body).note, r.principal);
  });
  app.post('/api/close/:month/explain', async (r) => {
    need(r, 'requests:write');
    return close.explain(parse(MonthParam, r.params).month, parse(CloseExplainInput, r.body), r.principal);
  });
  app.post('/api/close/:month/lock', async (r) => {
    need(r, 'admin');
    return close.sign(parse(MonthParam, r.params).month, parse(LockSignInput, r.body), r.principal);
  });
  app.post('/api/close/:month/reopen', async (r, reply) => {
    need(r, 'admin');
    const { requestId, close: view } = await close.reopen(
      parse(MonthParam, r.params).month,
      parse(ReopenInput, r.body).reason,
      r.principal,
    );
    return reply.status(201).send({ request: await requests.view(requestId, r.principal), close: view });
  });

  // 016 The snapshot ---------------------------------------------------------------------------------------------------
  app.get('/api/close/:month/snapshot', async (r) => {
    need(r, 'read');
    const month = parse(MonthParam, r.params).month;
    const s = await snapshots.latest(month);
    if (!s) throw notFound(`${month}'s snapshot`);
    await close.served(month, r.principal);
    const p = await close.period(month);
    return snapshots.viewOf(s, p.status === 'locked' && !p.reopened ? true : await snapshots.isCurrent(s));
  });

  // 013 Accruals -------------------------------------------------------------------------------------------------------
  app.get('/api/accruals', async (r) => (need(r, 'read'), accruals.list(monthOf(r))));
  // Review of wave 4: the journal (frozen when the accrual is accepted), as JSON and as the CSV to book.
  const preview = async (month: string) => (await accruals.list(month)).current;
  app.get('/api/accruals/journal', async (r) => {
    need(r, 'read');
    const month = monthOf(r);
    return journal.view(month, await preview(month));
  });
  app.get('/api/accruals/journal.csv', async (r, reply) => {
    need(r, 'read');
    const month = monthOf(r);
    const j = await journal.csv(month, await preview(month));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="landledger-accrual-journal-${month}.csv"`)
      .send(j.csv);
  });
  app.get('/api/accruals/roll-forward', async (r) => {
    need(r, 'read');
    const month = monthOf(r);
    return journal.rollForward(month, await preview(month));
  });
  // The chart-of-accounts mapping: read by anyone, a new version proposed by a controller and decided as a request.
  app.get('/api/coa', async (r) => (need(r, 'read'), journal.coa()));
  app.post('/api/coa/proposals', async (r, reply) => {
    need(r, 'admin');
    const out = await journal.propose(parse(CoaMappingProposeInput, r.body), r.principal);
    return reply.status(201).send({ version: out.version, request: await requests.view(out.requestId, r.principal) });
  });
  app.post('/api/accruals/:month/propose', async (r, reply) => {
    need(r, 'requests:write');
    const v = await accruals.propose(
      parse(MonthParam, r.params).month,
      parse(AccrualProposeInput, r.body).note,
      r.principal,
    );
    return reply.status(201).send(v);
  });
  app.post('/api/accruals/:id/accept', async (r) => {
    need(r, 'admin');
    return accruals.accept(parse(Id, r.params).id, parse(AccrualAcceptInput, r.body), r.principal);
  });

  // 014 Forecast history -----------------------------------------------------------------------------------------------
  app.get('/api/forecast/history', async (r) => {
    need(r, 'read');
    const q = parse(HistoryQuery, r.query);
    const month = q.month ?? localParts(now().getTime(), services.config.timeZone).date.slice(0, 7);
    const s = await snapshots.latest(month);
    const actual =
      s === null
        ? null
        : q.costCenter === TOTAL
          ? s.figures.total.total
          : (s.figures.byCostCenter.find((c) => c.code === q.costCenter)?.total ?? null);
    return forecastHistory.view(month, q.costCenter, actual);
  });

  // 015 Variance notes -------------------------------------------------------------------------------------------------
  const readOrDraft = (r: FastifyRequest) => {
    if (r.principal.scopes.includes('notes:draft')) return;
    requireScope(r.principal, 'read');
  };
  app.get('/api/notes', async (r) => (need(r, 'read'), notes.list(monthOf(r))));
  app.get('/api/notes/:month/figures', async (r) => (readOrDraft(r), notes.figures(parse(MonthParam, r.params).month)));
  app.post('/api/notes/:month/drafts', async (r, reply) => {
    need(r, 'notes:draft');
    if (r.principal.kind === 'dev') throw new ApiError('forbidden', 'A note is drafted by an agent key or a person');
    const input = parse(NoteDraftInput, r.body);
    return reply.status(201).send(await notes.draft(parse(MonthParam, r.params).month, input, r.principal));
  });
  app.post('/api/notes/:month/template', async (r, reply) => {
    need(r, 'requests:write');
    const v = await notes.template(
      parse(MonthParam, r.params).month,
      parse(NoteTemplateInput, r.body).costCenter,
      r.principal,
    );
    return reply.status(201).send({ notes: v });
  });
  app.post('/api/notes/:id/accept', async (r) => {
    need(r, 'requests:write');
    return notes.accept(parse(Id, r.params).id, parse(NoteAcceptInput, r.body), r.principal);
  });
  app.post('/api/notes/:id/reject', async (r) => {
    need(r, 'requests:write');
    return notes.reject(parse(Id, r.params).id, parse(NoteRejectInput, r.body), r.principal);
  });

  // 017 Datarails ------------------------------------------------------------------------------------------------------
  app.get('/api/datarails', async (r) => (need(r, 'read'), datarails.status()));
  app.post('/api/datarails/budgets/pull', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await datarails.pull(parse(DatarailsPullInput, r.body), r.principal));
  });
  app.post('/api/datarails/budgets/pulls/:id/accept', async (r) => {
    need(r, 'admin');
    return datarails.accept(parse(Id, r.params).id, parse(DatarailsPullDecideInput, r.body), r.principal);
  });
  app.post('/api/datarails/budgets/pulls/:id/reject', async (r) => {
    need(r, 'admin');
    return datarails.reject(parse(Id, r.params).id, parse(DatarailsPullRejectInput, r.body).reason, r.principal);
  });
  app.post('/api/datarails/uploads', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await datarails.upload(parse(DatarailsUploadInput, r.body).month, r.principal));
  });

  // 018 The month-end package ------------------------------------------------------------------------------------------
  app.get('/api/close/:month/package', async (r, reply) => {
    need(r, 'read');
    const month = parse(MonthParam, r.params).month;
    await close.served(month, r.principal);
    if (parse(PackageQuery, r.query).format === 'html')
      return reply.header('content-type', 'text/html; charset=utf-8').send(await packages.html(month));
    return packages.json(month);
  });
  app.get('/api/close/:month/package.zip', async (r, reply) => {
    need(r, 'read');
    const z = await packages.zip(parse(MonthParam, r.params).month);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${z.name}"`)
      .send(z.data);
  });

  // 019 Incident cost --------------------------------------------------------------------------------------------------
  app.get('/api/cost/window', async (r) => {
    need(r, 'read');
    return costWindow(services.spend, parse(CostWindowQuery, r.query), now);
  });
}
