# Plan 008: Agents' unit economics

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/contracts` | `AgentsView`, `AgentRow`, `AgentEconomics` (in `LedgerEvidence`) |
| `apps/api` | `agents.ts` (ledger cost per agent, the Clickland Agent Value client with a 10-minute cache, the suggestion rule); `config.ts` (`LANDLEDGER_CLICKLAND_VALUE_KEY`); `requests.ts` (evidence) |
| `apps/console` | `routes/agents.tsx`; the AI budget's evidence on `request.tsx` |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | A suggestion is advice to an owner; nothing changes by it. |
| 2. Estimated or invoiced | PASS | Agent cost carries its invoiced share; value is labelled capacity, not cash. |
| 3. Money is exact | PASS | Cost in micro-units; Clickland's value (a JSON number) is read as a decimal string, never summed with ledger money. |
| 4–7 | PASS | Read only; local; Clickland read with a narrow key in an untracked file; this spec. |

## Design

- Ledger lines of the month with `tags.agent`; per agent: cost, invoiced, AI vs other, cost center by the largest
  allocated share, agent name from `tags.agentName`.
- Clickland: one call per month window with `service=<LANDLEDGER_LANDFLOW_SERVICE>`; rows matched by name, unmatched
  Clickland agents of that service listed with no ledger cost.
