/**
 * What each screen will show (docs/ui.md) and the wave that builds it (docs/plan.md). A screen not built yet is a
 * placeholder that says so (router.tsx lists the built ones).
 */
export interface Screen {
  path: string;
  wave: number;
  purpose: string;
  shows: string[];
  note?: string;
}

export const SCREENS: Screen[] = [
  {
    path: '/overview',
    wave: 1,
    purpose: 'The CFO’s screen: is technology spend on plan this month, and what needs a decision.',
    shows: [
      'Four figures: month to date, forecast to month-end with its range, budget, and budget left after reservations',
      'The month’s burn: cumulative actual, the forecast and its band, the budget line, annotated where something happened',
      'Cost centers: month to date, budget, forecast, actual and reserved against budget, and the on track, at risk or over pill',
      'Needs you: approvals waiting on you, cost anomalies, the close checklist',
      'The split by category (AI models, cluster compute, storage, SaaS) and by P&L class',
    ],
    note: 'Wave 1 brings the spend and budgets; reservations and approvals come in wave 2, forecasts and anomalies in wave 3.',
  },
  {
    path: '/explore',
    wave: 1,
    purpose: 'Where spend comes from.',
    shows: [
      'Group and filter by cost center, team, product, service, namespace, agent, model, provider or P&L class',
      'A stacked daily bar over the period',
      'Each group’s estimated and invoiced parts, change against last month, and share',
      'Drill-down from cost center to service to resource; a service opens its Clickland page',
      'Shared and idle cost as its own row, Shared pool, never folded into teams',
    ],
  },
  {
    path: '/budgets',
    wave: 1,
    purpose: 'Budget against actual, per cost center and month.',
    shows: [
      'Budget, actual, reserved, available, forecast, and the variance with its percentage',
      'The budget’s version and source (Datarails, a spreadsheet, entered here)',
      'A cost center’s months, its owner and the reservations against it',
    ],
    note: 'Wave 1 reads budgets from a CSV; Datarails comes in wave 4.',
  },
  {
    path: '/reconciliation',
    wave: 3,
    purpose: 'AI usage tied to the providers’ invoices.',
    shows: [
      'Per provider, model and month: estimated, invoiced, the variance and whether it is within ±2%',
      'The invoices imported, their versions and what each posted; a controller or the CFO imports and voids',
    ],
  },
  {
    path: '/approvals',
    wave: 2,
    purpose: 'Spend above the threshold, waiting on a person. Agents request; people decide.',
    shows: [
      'Requests waiting on you, then the ones you raised, then decided ones',
      'Each with its amount per month or once, cost center, budget left after it, who asked, its age and its step',
      'One request: what and why, the evidence (cost change, budget before and after, forecast), the path of steps, and decide',
      'One tap to approve on a phone, after the evidence; you can’t approve your own request',
    ],
    note: 'Thresholds decided: automatic under $500 a month, budget owner to $5,000, Finance to $25,000, CFO above.',
  },
  {
    path: '/contracts',
    wave: 3,
    purpose: 'Vendor contracts and subscriptions, renewals first.',
    shows: [
      'Vendor, product, cost center, annual value, seats used of seats paid',
      'Term, renewal date and notice date; renewals inside their notice window come first',
    ],
  },
  {
    path: '/agents',
    wave: 3,
    purpose: 'What each AI agent costs and what it gives back.',
    shows: [
      'Cost (models and compute), runs and outcomes, cost per outcome',
      'Capacity freed (hours saved × a blended role rate, labelled as capacity, not cash)',
      'Its owner and cost center, and a suggestion: keep, scale, review or retire',
    ],
    note: 'From Landflow’s usage ledger and Clickland’s Agent Value.',
  },
  {
    path: '/close',
    wave: 4,
    purpose: 'The close of a period as a checklist, in order.',
    shows: [
      'Usage ingested to the last day; AI usage reconciled to the providers’ invoices (within ±2%)',
      'Unallocated spend under its limit; the accrual proposal for usage not yet invoiced',
      'Variance notes drafted by an agent and accepted by an analyst; the upload to Datarails',
      'The period locked: it can’t change, and corrections post to the open one',
    ],
  },
  {
    path: '/audit',
    wave: 2,
    purpose: 'Every decision, rule, rate and period change, newest first.',
    shows: [
      'Who, what and when, the record’s hash and its chain position',
      'Verify chain: each record carries the hash of the one before, so a changed record breaks the chain',
      'Auditors see this screen, Explore and Budgets, read-only',
    ],
  },
];

export const screenAt = (path: string) => SCREENS.find((s) => s.path === path);
