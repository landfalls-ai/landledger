import { anchorAudit } from './anchors.js';
import { AuditLog } from './audit.js';
import { Sessions } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { Dimensions } from './dimensions.js';
import { Keys } from './keys.js';
import { Periods, Records } from './ledger.js';
import { OidcClient } from './oidc.js';
import { Webhooks } from './webhooks.js';
import { Allocation } from './allocation.js';
import { Budgets } from './budgets.js';
import { Ingest, type IngestLog } from './ingest/runner.js';
import { ClicklandClient, LandflowClient } from './ingest/sources.js';
import { emitCostMetrics } from './metrics.js';
import { RateCards } from './ratecards.js';
import { Scim, ScimTokens } from './scim.js';
import { Exceptions } from './exceptions.js';
import { CostCenterOwners } from './owners.js';
import { PersonLinks, RelayChannels } from './relays.js';
import { Policies } from './policies.js';
import { Proposals } from './proposals.js';
import { Requests } from './requests.js';
import { Reservations } from './reservations.js';
import { SecretBox } from './secrets.js';
import { Spend } from './spend.js';
import { Agents, AgentValueClient } from './agents.js';
import { AccessReviews } from './access-review.js';
import { Anomalies } from './anomalies.js';
import { Contracts } from './contracts.js';
import { Invoices } from './invoices.js';
import { Accruals } from './accruals.js';
import { Close } from './close.js';
import { Datarails } from './datarails.js';
import { ForecastHistory } from './forecast-history.js';
import { Notes } from './notes.js';
import { MonthEndPackages } from './package.js';
import { Snapshots } from './snapshot.js';

/** Everything the routes call. */
export interface Services {
  config: Config;
  sql: Sql;
  audit: AuditLog;
  keys: Keys;
  sessions: Sessions;
  dimensions: Dimensions;
  webhooks: Webhooks;
  periods: Periods;
  records: Records;
  rateCards: RateCards;
  allocation: Allocation;
  budgets: Budgets;
  spend: Spend;
  ingest: Ingest;
  scim: Scim;
  scimTokens: ScimTokens;
  policies: Policies;
  reservations: Reservations;
  requests: Requests;
  proposals: Proposals;
  exceptions: Exceptions;
  owners: CostCenterOwners;
  links: PersonLinks;
  relayChannels: RelayChannels;
  invoices: Invoices;
  anomalies: Anomalies;
  accessReviews: AccessReviews;
  agents: Agents;
  contracts: Contracts;
  landflow: LandflowClient | null;
  /** Wave 4, "Month-end" (specs 012–019). */
  forecastHistory: ForecastHistory;
  snapshots: Snapshots;
  accruals: Accruals;
  notes: Notes;
  close: Close;
  datarails: Datarails;
  packages: MonthEndPackages;
  /** The clock every service shares (a test's fixed time). */
  now: () => Date;
  log: IngestLog;
  fetchImpl: typeof fetch;
}

const SILENT: IngestLog = { info() {}, warn() {}, error() {} };

export function createServices(
  config: Config,
  sql: Sql,
  fetchImpl: typeof fetch = fetch,
  log: IngestLog = SILENT,
  now: () => Date = () => new Date(),
): Services {
  const audit = new AuditLog(sql);
  const oidc = config.oidc ? new OidcClient(config.oidc, fetchImpl) : null;
  const box = config.secretKey ? new SecretBox(config.secretKey) : null;
  const webhooks = new Webhooks(sql, audit, fetchImpl, box);
  const records = new Records(sql);
  const rateCards = new RateCards(sql, audit);
  const allocation = new Allocation(sql, audit);
  const budgets = new Budgets(sql, audit);
  const spend = new Spend(sql, allocation, budgets, rateCards, config.clicklandConsoleUrl, now);
  const landflow = config.landflow ? new LandflowClient(config.landflow.url, config.landflow.key, fetchImpl) : null;
  const clickland = config.clickland
    ? new ClicklandClient(config.clickland.url, config.clickland.key, fetchImpl, config.clickland.labels)
    : null;
  // Set below: ingest links estimates for an invoiced month to the invoice (review of wave 3, B1).
  let invoicesRef: Invoices | null = null;
  const ingest = new Ingest(sql, records, rateCards, {
    landflow,
    clickland,
    landflowHost: {
      service: config.landflow?.service ?? 'landflow-host',
      namespace: config.landflow?.namespace ?? 'landflow-dev',
    },
    dockerSharesCluster: config.dockerSharesCluster,
    log,
    audit,
    now,
    // Records entered: allocate the months they landed in (their own, or the open month for a correction).
    afterRun: async (run) => {
      if (run.provisional || run.newCount + run.correctedCount === 0) return;
      for (const month of new Set([run.day.slice(0, 7), now().toISOString().slice(0, 7)]))
        await allocation.allocatePending(month);
    },
    afterAppend: (tx, recs) => invoicesRef?.coverLate(tx, recs) ?? Promise.resolve(0),
  });
  const policies = new Policies(sql);
  const reservations = new Reservations(sql, audit, spend, now);
  const owners = new CostCenterOwners(sql, audit);
  const links = new PersonLinks(sql, audit);
  const relayChannels = new RelayChannels(sql, audit, box, now);
  const requests = new Requests(
    sql,
    audit,
    webhooks,
    spend,
    reservations,
    policies,
    rateCards,
    allocation,
    config,
    now,
    owners,
    links,
    relayChannels,
  );
  // A rate card or rule set approved through its request: re-price every day from its first, or rebuild open months.
  requests.afterApplied = async (change, info) => {
    if (change.type === 'rate_card_version')
      await ingest.reprice(info.effectiveFrom, info.by, `rate card v${info.version} approved`);
    else if (change.type === 'rule_set_version')
      await allocation.rebuildOpen(info.effectiveFrom.slice(0, 7), `rule set v${info.version} approved`, {
        actor: info.by,
        actorKind: 'person',
      });
  };
  const proposals = new Proposals(sql, audit, spend, allocation, requests, now);
  // Wave 3: invoices post records; the months they land in are allocated like an ingest run's.
  const invoices = new Invoices(sql, audit, spend, config, now, async (months) => {
    for (const month of months) await allocation.allocatePending(month);
  });
  invoicesRef = invoices;
  const exceptions = new Exceptions(sql, audit, webhooks, spend, policies, now, budgets, config.consoleUrl);
  const agents = new Agents(
    spend,
    config.clicklandApi?.valueKey
      ? new AgentValueClient(config.clicklandApi.url, config.clicklandApi.valueKey, fetchImpl)
      : null,
    config.landflow?.service ?? 'landflow-host',
    now,
  );
  const contracts = new Contracts(
    sql,
    audit,
    webhooks,
    spend,
    {
      windowDays: config.renewalWindowDays ?? 30,
      consoleUrl: config.consoleUrl,
      timeZone: config.timeZone,
      businessDays: config.businessDays,
      holidays: config.holidays,
      devAuth: config.devAuth,
    },
    now,
  );
  requests.contracts = contracts;
  exceptions.contracts = contracts;
  spend.contractedIn = async (month, fromDay) => (await contracts.contractedIn(month, fromDay)).total;
  // Decision 9: an import above the second-person line raises a contract request, Landledger's own origin.
  contracts.raiseRequest = async (input, by, origin) => {
    const { request } = await requests.create(input as never, by, 'session', { origin });
    return { id: request.id, number: request.number };
  };
  // Spec 008: an AI budget request's evidence shows its agent's cost per outcome.
  requests.agentEconomics = (agentId, month, monthly) => agents.economics(agentId, month, monthly);
  const anomalies = new Anomalies(
    sql,
    audit,
    webhooks,
    spend,
    policies,
    log,
    { minUsd: config.anomalyMinUsd ?? '1', consoleUrl: config.consoleUrl },
    now,
  );
  const periods = new Periods(sql, audit, webhooks, now);
  const accessReviews = new AccessReviews(
    sql,
    audit,
    webhooks,
    owners,
    { consoleUrl: config.consoleUrl, timeZone: config.timeZone },
    now,
  );
  // Wave 4: the stored forecast, the frozen snapshot, accruals, notes, the close, Datarails and the package.
  const forecastHistory = new ForecastHistory(sql, spend, now);
  const snapshots = new Snapshots(sql, audit, spend, budgets, invoices, forecastHistory);
  const accruals = new Accruals(sql, audit, webhooks, spend, snapshots, config.consoleUrl, now);
  let closeRef: Close | null = null;
  const period = (month: string, tx?: Parameters<Close['period']>[1]) => closeRef!.period(month, tx);
  const notes = new Notes(sql, audit, webhooks, snapshots, period, config.consoleUrl);
  const close = new Close(
    sql,
    audit,
    webhooks,
    periods,
    invoices,
    anomalies,
    accessReviews,
    snapshots,
    accruals,
    notes,
    requests,
    { consoleUrl: config.consoleUrl, unallocatedPct: config.closeUnallocatedPct ?? '5' },
    log,
    now,
  );
  closeRef = close;
  accruals.gates = { gates: (month) => close.gates(month), period };
  const datarails = new Datarails(
    sql,
    audit,
    webhooks,
    budgets,
    snapshots,
    notes,
    period,
    config.datarails ?? {
      mcpUrl: 'http://127.0.0.1:4819/mcp',
      uploadUrl: 'http://127.0.0.1:4819/api/v1/fileboxes/upload_file',
      mcpToken: 'fake-datarails-dev-token',
      user: 'landledger-sync',
      password: 'fake-datarails-dev',
      filebox: 'fb_technology_costs',
      real: false,
    },
    fetchImpl,
  );
  const packages = new MonthEndPackages(
    sql,
    audit,
    close,
    snapshots,
    accruals,
    notes,
    invoices,
    exceptions,
    anomalies,
    datarails,
    now,
  );
  return {
    config,
    sql,
    audit,
    keys: new Keys(sql, audit),
    sessions: new Sessions(sql, config, audit, oidc, box),
    dimensions: new Dimensions(sql),
    webhooks,
    periods,
    records,
    rateCards,
    allocation,
    budgets,
    spend,
    ingest,
    scim: new Scim(sql, audit, config.oidc?.issuer ?? 'http://localhost:4402/oidc'),
    scimTokens: new ScimTokens(sql, audit),
    policies,
    reservations,
    requests,
    proposals,
    exceptions,
    owners,
    links,
    relayChannels,
    invoices,
    anomalies,
    agents,
    contracts,
    accessReviews,
    landflow,
    forecastHistory,
    snapshots,
    accruals,
    notes,
    close,
    datarails,
    packages,
    now,
    log,
    fetchImpl,
  };
}

/** Small loops that claim due rows, so replicas can share the work: the webhook dispatcher and the cleanup. */
export function startBackgroundJobs(services: Services, log: (msg: string, err?: unknown) => void): () => void {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const loop = (name: string, everyMs: number, run: () => Promise<number>) => {
    const tick = async () => {
      if (stopped) return;
      let wait = everyMs;
      try {
        if ((await run()) > 0) wait = 50; // keep going while there is a backlog
      } catch (error) {
        log(`${name} failed`, error);
        wait = everyMs * 4;
      }
      if (!stopped) timers.add(setTimeout(tick, wait));
    };
    timers.add(setTimeout(tick, everyMs));
  };
  loop('webhook dispatcher', 2_000, () => services.webhooks.dispatchDue());
  loop('session cleanup', 3_600_000, async () => (await services.sessions.cleanup(), 0));
  // Wave 2: step deadlines (escalate, then expire), reservations consumed or released, budget alerts, the weekly report.
  loop('step deadlines', 60_000, async () => (await services.requests.expireDue(), 0));
  loop('reservations', 600_000, async () => (await services.reservations.settle(), 0));
  loop('budget alerts', 900_000, async () => (await services.exceptions.budgetAlerts(), 0));
  loop('weekly exceptions', 3_600_000, () => services.exceptions.weekly());
  // Wave 3 (spec 007): anomalies every hour, today's cost as it accrues and the approval patterns; first after 2 min.
  loop('anomalies', 3_600_000, async () => (await services.anomalies.scan(), 0));
  // Spec 009: contract.renewal_due once per contract and renewal date, every hour.
  loop('renewals', 3_600_000, () => services.contracts.renewalAlerts());
  // Spec 010 (review of wave 3): a seat approved but unapplied for 30 days goes back to its contract.
  loop('seat expiry', 3_600_000, () => services.requests.expireSeats());
  // Spec 011: access_review.due once a quarter while its review is not complete, checked every hour.
  loop('access review', 3_600_000, async () => (await services.accessReviews.dueNotice(), 0));
  // Wave 4 (spec 014): the day's forecast per cost center, stored once a UTC day (checked every hour; first after 3 min).
  loop('forecast history', 3_600_000, async () => (await services.forecastHistory.record(), 0));
  timers.add(
    setTimeout(() => void services.forecastHistory.record().catch((e) => log('forecast history failed', e)), 180_000),
  );
  timers.add(setTimeout(() => void services.anomalies.scan().catch((e) => log('anomalies failed', e)), 120_000));
  const { config } = services;
  if (config.auditAnchorMinutes > 0) {
    // The audit chain's head, out to Clickland and webhooks (anchors.ts); the first a minute after start.
    const anchor = () => anchorAudit(services.sql, services.webhooks, services.log).then(() => 0);
    loop('audit anchor', config.auditAnchorMinutes * 60_000, anchor);
    timers.add(setTimeout(() => void anchor().catch((e) => log('audit anchor failed', e)), 60_000));
  }
  if (config.ingestJobs && services.ingest.sources().length) {
    // Ingest: every hour, today's provisional figures and the recent complete days (runner.ts tick); first after 20 s.
    loop('ingest', 3_600_000, async () => (await services.ingest.tick(), 0));
    timers.add(setTimeout(() => void services.ingest.tick().catch((e) => log('ingest failed', e)), 20_000));
  }
  if (config.ingestJobs && config.costMetricsEndpoint) {
    const endpoint = config.costMetricsEndpoint;
    loop('cost metrics', 300_000, async () => {
      const n = await emitCostMetrics(services.spend, endpoint, services.fetchImpl);
      services.log.info({ points: n, endpoint }, `cost metrics: ${n} points sent`);
      return 0;
    });
  }
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
