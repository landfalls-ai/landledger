# Agents' unit economics

Wave 3, [spec 008](../specs/008-agents/spec.md). AI agents are the fastest-growing line. Each agent's month is shown as
a unit: what it cost, what it did, what one outcome costs, the time it gave back, who owns it, and a suggestion its
owner can act on. `apps/api/src/agents.ts`, `GET /api/agents?month=`, the console's **Value → Agents**.

## The figures

- **Cost:** from the ledger, booked in the month (today's provisional rows included), by the `agent` tag Landflow's
  usage carries. _Models_ is AI and Machine Learning; _compute_ is any other record that carries the agent. None does
  today: workloads have no agent label, so compute is said to be not attributable (`compute: null`), not shown as
  zero. _Invoiced_ is the part an invoice replaced ([invoices.md](invoices.md)): an invoice's share keeps the
  estimate's tags.
- **Runs, outcomes, value:** from Clickland's Agent Value, `GET /api/agents/value?from&to` for the month so far, with
  a `read` key (`LANDLEDGER_CLICKLAND_VALUE_KEY`), cached five minutes. An agent is matched **by name within
  Landflow's service** (`landflow-host`), case-insensitively, and only when the name is unique on both sides (two
  agents sharing a name never share outcomes; the page notes the ambiguity). Clickland agents in other services (the
  `demo-*` ones) are not Landflow's and are left out. A Landflow agent that only Clickland knows (runs, no cost in the
  ledger) is listed with $0 and says so. Hours and success rates are kept as exact decimals.
- **Outcomes are self-reported** (`outcomesSource: 'self-reported'`): the agents' own telemetry, through Clickland. An
  agent is **measured** when Clickland credits it an outcome or says it is instrumented (`outcomesInstrumented`);
  otherwise it says _Outcomes not measured_ (review of wave 3, should-fix 14): no outcome definition covers it, and
  sub-agents never get one, so zero outcomes says nothing about its value. Totals count measured agents' outcomes.
- **Cost per outcome** = cost ÷ outcomes; **value per outcome** = Clickland's value ÷ outcomes; only for a measured
  agent with outcomes.
- **Capacity freed:** Clickland's value ÷ its hourly rate, in hours, and the value itself, labelled _capacity, not
  cash_. Salaries are never used.
- **Owner and cost center:** the cost center most of the agent's cost is allocated to, and that cost center's owner.
- Without a key the page says _no Clickland key_ and shows cost only. When Clickland does not answer, it says
  _Clickland down_ with the reason.

## The suggestion

The first rule that holds, shown beside it; the owner decides, Landledger only suggests:

| Suggestion | Rule |
|---|---|
| Outcomes not measured | Clickland credits it no outcome and doesn't say it is instrumented: nothing is said about value |
| Retire | measured, $10 or more this month, 10 or more runs, and no outcome or outcomes costing 3 × their value or more |
| Review | an outcome costs more than it is worth (cost > value), or under 80% of 5 or more runs succeeded |
| Scale | 10 or more outcomes, value at least 5 × cost, and 90% or more succeeded (or no success rate) |
| Keep | otherwise, including under $10 a month, too few runs to say, and an agent Clickland knows nothing of |

## In an AI budget request

An `ai_budget` request raised for an agent carries `evidence.agentEconomics`: the agent's month (cost, outcomes, cost
and value per outcome, the suggestion and its rule, `measured`, outcomes labelled self-reported) and **what the raise
buys**: the request's monthly amount ÷ this
month's cost per outcome, in outcomes a month. The Request page shows it as _What <agent> costs per outcome_. If
Clickland can't say, the card says so and the request is decided as before.

## Not yet

Compute attributed to agents (needs agent labels on workloads, [integrations.md](integrations.md#landflow)); per-run
cost; an agent's own budget caps (Landflow's); Clickland's `outcomesInstrumented` flag (asked of Clickland, until then
an agent is measured once it has an outcome).
