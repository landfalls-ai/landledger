# Landledger docs

| Page | What it covers |
|---|---|
| [plan.md](plan.md) | The waves, the principles, sibling changes, measures, open decisions |
| [architecture.md](architecture.md) | Processes, code map, data, jobs, the land family's interfaces, controls |
| [development.md](development.md) | Setup, ports, commands, where each area's code starts, conventions, how to check a change |
| [money.md](money.md) | Micro-units, the two rounding modes, splits, FX, records and corrections, periods |
| [ingest.md](ingest.md) | Landflow's AI calls and Clickland's usage into priced records: runs, completeness, corrections, cache tokens, the CLI |
| [rate-cards.md](rate-cards.md) | The rate card's lines, how a version is proposed and approved by a person, v1 on this machine |
| [allocation.md](allocation.md) | Rules, first match, the shared pool and Unallocated, direct and spread layers, generations, the dev seed |
| [approvals.md](approvals.md) | Requests, confirmation, policies, cost center owners, decisions by people only (console, or a verified Slack relay), evidence snapshots and who saw them, deadlines and escalation, reservations, rate card and rule set proposals with a preview, the exceptions report and stored reports, the evidence pack, keys and webhooks |
| [identity.md](identity.md) | Sign-in, roles from groups, effective groups, SCIM 2.0 after Clickland's, deactivation, `pnpm scim:token` |
| [spend.md](spend.md) | Overview, Explore, Budgets: the figures, the forecast, exports, the MCP tools, cost metrics in Clickland |
| [invoices.md](invoices.md) | Invoices and reconciliation: the CSV, posting beside the estimates they replace, never counting twice, corrections and voids, a locked month's true-up, reconciliation per provider and model, a request from approval to invoice |
| [anomalies.md](anomalies.md) | Cost anomalies against a median and MAD baseline, approval patterns (split, automatic again and again, fast relay, one approver for one requester), webhooks, Clickland's alert rule, acknowledging, the dev-only spike |
| [agents.md](agents.md) | Agents' unit economics: cost from the ledger, outcomes and value from Clickland's Agent Value, cost per outcome, capacity freed, the keep, scale, review or retire rule, and what an AI budget raise buys |
| [contracts.md](contracts.md) | Contracts and renewals: the CSV, versions, the notice window and `contract.renewal_due`, a contract request for its TCV and term that reserves seats not money, a seat request on a contract and its seats left |
| [access-review.md](access-review.md) | The quarterly access review: a snapshot of people with roles, keys, Slack links, relay channels and cost center owners; keep or revoke by the controller or the CFO, never about themselves; `access_review.due` |
| [close.md](close.md) | The month-end close: open, closing, locked; the ten computed steps and their explanations, the four-eyes lock on the snapshot each signer was shown and its anchored audit entry, segregation of duties, reopening by a request the CFO approves and a round someone starts, the frozen snapshot, the package stored and hashed per round |
| [accruals.md](accruals.md) | The accrual proposal (estimates not yet invoiced, contracts by their billing terms, prepaid amortisation), a controller's acceptance, reversal when the invoice posts, the journal frozen at acceptance with entry ids, the chart-of-accounts mapping, the roll-forward with aging |
| [variance-notes.md](variance-notes.md) | Notes drafted by an agent's `notes:draft` key with figures checked against the snapshot, accepted by an analyst who isn't the sponsor; the template fallback; forecast history and day-10 accuracy |
| [datarails.md](datarails.md) | The Datarails connector against `fake-datarails`: budgets in over MCP as a pending pull, actuals and notes out through the FileBox upload; no tenant: wave 5 is our own FP&A product |
| [integrations.md](integrations.md) | What Clickland, Landflow and Landbright need from Landledger's waves 3 and 4, and how each is called |
| [reference/api.md](reference/api.md), [reference/env.md](reference/env.md) | Every route and every environment variable |
| [ui.md](ui.md) | The console's screens and the rules they follow; `../ui/prototype.html` is the clickable version |
| [research.md](research.md) | Wave 0's study on one page: what OpenCost and FOCUS 1.4 teach, what the sources give today, the decisions (D1–D15) and what is still open |
| [research/opencost.md](research/opencost.md) | OpenCost v1.121.3 read by file and line: the cost model, max(request, usage), idle, shared cost, custom pricing, the API, what Landledger takes, changes or rejects |
| [research/focus.md](research/focus.md) | FOCUS 1.4: the 45 columns kept and the ones dropped, estimated against invoiced, AI tokens as rows, corrections, the `x_` columns, periods |
| [../specs/](../specs/) | Feature specs (spec, plan, tasks): [001 money and records](../specs/001-money-and-records/spec.md), [002 ingest and pricing](../specs/002-ingest/spec.md), [003 allocation](../specs/003-allocation/spec.md), [004 approvals](../specs/004-approvals/spec.md), [005 invoices](../specs/005-invoices/spec.md), [006 forecasts](../specs/006-forecasts/spec.md), [007 anomalies](../specs/007-anomalies/spec.md), [008 agents](../specs/008-agents/spec.md), [009 contracts](../specs/009-contracts/spec.md), [010 tool or seat](../specs/010-tool-or-seat/spec.md), [011 access review](../specs/011-access-review/spec.md), [012 close](../specs/012-close/spec.md), [013 accruals](../specs/013-accruals/spec.md), [014 forecast history](../specs/014-forecast-history/spec.md), [015 variance notes](../specs/015-variance-notes/spec.md), [016 snapshot](../specs/016-snapshot/spec.md), [017 Datarails](../specs/017-datarails/spec.md), [018 package](../specs/018-package/spec.md), [019 incident cost](../specs/019-incident-cost/spec.md), [020 seat within contract](../specs/020-seat-within-contract/spec.md) |
| [../study/README.md](../study/README.md) | The study's outputs: OpenCost's source graphs (Craft Anything) and the read-only probe of Clickland's metrics, and how to re-create them |
| [history.md](history.md) | Every change, in order |

The readable page with the diagrams and screenshots is `../ui/plan.html` (published at https://claude.ai/artifact/SPq2ui6QtGsdCiBCvA7vV5); `ui/shoot.cjs` retakes the screenshots with Playwright.

`scripts/fetch-upstream.sh` fetches the pinned sources the research cites into `upstream/` (git-ignored); `scripts/fetch-tools.sh` fetches Craft Anything into `tools/craft-anything/`.
