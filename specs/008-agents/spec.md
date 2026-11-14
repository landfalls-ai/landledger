# Feature 008: Agents' unit economics (wave 3, "Plan and reconcile")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · Screen: `#agents`
in `ui/prototype.html`

## Why

AI agents are the fastest-growing line. Finance needs each agent's month as a unit: what it cost, what it did, what
one outcome costs, the time it gave back, who owns it, and a plain suggestion an owner can act on. An approver of an
AI budget raise needs to see what the raise buys.

## User stories

1. **As FP&A**, Agents lists each AI agent's month: cost (models, and compute when it can be attributed), runs,
   outcomes, cost per outcome, capacity freed, owner and cost center, and a suggestion (keep, scale, review, retire)
   with the rule that gave it.
2. **As a budget owner** deciding an AI budget request, the evidence shows the agent's cost per outcome this month.

## Acceptance

- **Cost** per agent and month from the ledger (Landflow's usage, by the `agent` tag; invoiced where invoiced):
  models (AI and Machine Learning) and compute (any other record carrying the agent; none today: "not attributable"
  is said, not zero).
- **Runs, outcomes, value** from Clickland's Agent Value (`GET /api/agents/value?from&to&service`) for the month so
  far, matched to Landflow agents by name within Landflow's service; a Clickland key with `read` in the untracked env
  file (`LANDLEDGER_CLICKLAND_VALUE_KEY`). Without one, or when Clickland is down, the page says so and shows cost.
- **Cost per outcome** = Landledger's cost ÷ outcomes (none without outcomes). **Capacity freed** = Clickland's value
  ÷ its hourly rate, in hours, and × the rate as capacity, labelled *capacity, not cash*.
- **Owner and cost center**: the cost center most of its cost is allocated to, and that cost center's owner.
- **Suggestion**, first rule that holds: *retire* (10 or more runs, no outcome), *review* (cost per outcome above the
  value per outcome, or a success rate under 80% over 5 or more runs), *scale* (10 or more outcomes, value at least 5 × cost, success at
  least 90%), *keep* (otherwise, including too few runs to say). The rule is shown beside it. An owner decides.
- **AI budget evidence**: `agentEconomics` with the agent's month (cost, outcomes, cost per outcome, value per
  outcome, suggestion) and what the request's monthly amount buys at that cost per outcome.
- `GET /api/agents?month=`; console `#agents` (phone first, cards).

## Out of scope

Compute attributed to agents (needs agent labels on workloads), per-run cost, the agent's own budget caps
(Landflow's).
