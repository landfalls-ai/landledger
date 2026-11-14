# Rate cards

What a unit costs: one rate card (`rc_internal`), in versions, each a list of lines priced per FOCUS pricing unit.
Code: `apps/api/src/ratecards.ts`, `libs/pricing`; tables `rate_cards`, `rate_card_versions`, `rate_lines` (0001,
0002).

## Lines

| Lines | Unit | v1 price (USD) |
|---|---|---|
| CPU | `Core-Hours` | 0.034 |
| Memory | `GiB-Hours` | 0.0045 |
| Storage | `GB-Months` (730 hours) | 0.10 |
| Network egress | `GB` | 0.02, not applied while network is unpriced |
| AI, per Landflow price entry and meter (input, cache read, cache write, output, and each meter of a long-context tier) | `1000000 Tokens` | Landflow's price table (`GET /api/settings/ai-prices`, overrides first); `ollama:*` at 0 |

An AI line's `SkuPriceId` is `<provider>:<model>:[long:]<meter>`; lookup is by provider and model, exact first, then
the longest prefix (dated model ids find their family), as Landflow does.

## A version's life

1. **Proposed**: by the seed (the cluster lines), then `ingest ai-lines` or
   `POST /api/rate-cards/versions/:id/ai-lines` adds the AI lines from Landflow's table (audited
   `rate_card.lines_imported`). Lines can be added to a proposal only.
2. **Approved** by `POST /api/rate-cards/versions/:id/approve`: a **person** signed in with Landbright, a controller or
   the CFO, who did not propose it. An API key or an agent gets 403; a version with no lines, or one taking effect in a
   closing or locked month, is refused. Approval ends the version before it on the new one's first day and is audited
   (`rate_card.version_approved`, with approver, roles, lines and the version it ended). The database refuses changes
   to an approved version's lines.
3. Ingest prices each day with the version in effect that day. A new version changes figures only for days ingested
   or re-ingested after it, through corrections in open months.

## Live on this machine

Version 1 (`rcv_internal_1`, effective 2026-11-01, 136 lines: 4 cluster, 132 AI) was approved on 2026-11-14 at
19:09 UTC by `yoav.bendavid@landbright.test` (controller), signed in through Landbright in a visible Chrome. Before
it, ingest priced AI calls at Landflow's estimate and refused cluster days.

## Open

- The console shows the rate card and the approver but has no Approve button yet: an approver calls the route from
  their signed-in session. The approval inbox comes with requests in wave 2.
- Proposing a new version from the console (with a preview of the change) is not built.
