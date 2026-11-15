# Feature 019: Incident cost (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/spend.md](../../docs/spend.md)

## Why

When an incident closes, a Landflow flow writes its cost into the Landfall postmortem. It asks Landledger for the
cost of the affected services over the incident's window.

## User stories

1. **As Landflow's incident flow**, I call `GET /api/cost/window?services=…&from=…&to=…` with a `read` key and write
   the estimated cost into the postmortem.

## Acceptance

- Services as Explore names them (the `service` tag, else the service name).
- Each day's cost (ledger by charge day, and today's provisional rows) times the share of the day inside the window,
  exact to the micro-unit, labelled `estimated` with the method.
- Unknown services answer `known: false` and $0; at most 50 services and 31 days.

## Out of scope

Hourly records (the ledger is daily); revenue or SLA credits.
