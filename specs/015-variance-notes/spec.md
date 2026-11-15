# Feature 015: Variance notes (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/variance-notes.md](../../docs/variance-notes.md)

## Why

Finance wants each cost center's month explained: actual against budget and against the day-10 forecast, with what
drove it. An agent can draft that from Landledger's figures; a person accepts it. The figures a draft cites are
checked against the frozen snapshot, so a draft can't misquote the month.

## User stories

1. **As Landflow's variance flow**, on `notes.draft_requested` I read the figures, draft each note and post it with
   the figures I cite through a `notes:draft` key.
2. **As an analyst** (FP&A or a controller, not the agent's sponsor), I accept a draft, edit it, or reject it.
3. **As the controller**, when no agent answers, I draft from the template and an analyst accepts.

## Acceptance

- Needed notes: the month as a whole (`TOTAL`) and every cost center with an actual or a budget, from the snapshot.
- Figures: actual, budget, day-10 forecast, variance against each, drivers (top services, agents and models by
  change against the month before).
- `POST /api/notes/:month/drafts` (`notes:draft`): each cite equal to the snapshot's to the cent, else 422 with the
  mismatches; a stale snapshot 409; the agent and sponsor recorded; a new version each time.
- `POST /api/notes/:month/template`: deterministic text and cites from the figures.
- Accept (as shown or edited, a new version) or reject: FP&A or controller, never the sponsor or the version's
  writer; every version kept; audited; `note.accepted`.
- Scope `notes:draft` in the contract and the database; no role carries it.

## Out of scope

Writing notes into Datarails' commentary model (the upload carries them as a file).
