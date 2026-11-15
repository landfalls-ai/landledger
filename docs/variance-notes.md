# Variance notes

Wave 4, specs [015](../specs/015-variance-notes/spec.md) and [014](../specs/014-forecast-history/spec.md).
**An agent drafts; an analyst accepts.**

A note compares a month's actual spend with two figures: the budget, and the forecast as it stood on calendar day 10.
It also gives the drivers behind the difference.

| What | Where |
|---|---|
| Code | `apps/api/src/notes.ts` and `forecast-history.ts` |
| Console page | `/close/notes` |
| Close step | 8 ([close.md](close.md)) |

## Which notes a month needs

The snapshot frozen at step 7 names the notes a month needs:

- `TOTAL`, the month as a whole;
- each cost center that has an actual or a budget.

For each note, the snapshot also lists the figures it may cite:

- `actual`;
- `budget`;
- `forecast_day10`;
- `variance_budget` and `variance_forecast`;
- the largest month-on-month changes by service, agent and model (`driver_service`, `driver_agent`, `driver_model`,
  each with its `key`).

`GET /api/notes/:month/figures` returns them along with the snapshot's sha256.

## Drafts by an agent

Accepting the accrual sends the `notes.draft_requested` webhook, once per snapshot. It carries the month, the
snapshot's sha256, every needed note with its figures, and `draftUrl`.

Landflow's flow then drafts each note with a key that has the `notes:draft` scope. It sends
`POST /api/notes/:month/drafts` with:

- the cost center;
- the snapshot's sha256;
- the text;
- the figures it cites;
- the agent, the sponsor and the Landflow run.

Landledger checks every cite against the snapshot to the cent. Any difference refuses the draft with 422, and
`details.mismatches` names each one. A draft against a snapshot that is no longer current gets 409.

The sponsor is the person who answers for the agent. It defaults to the person who minted the key.

No role grants `notes:draft`. Only an admin mints it, on an agent's key. On this machine that key is
`landflow notes`, kept in `~/.config/land-family/landledger-landflow.env` as `LANDLEDGER_NOTES_KEY`.

## The template fallback

When no agent answers, a person can call `POST /api/notes/:month/template`. It writes a deterministic draft from the
same figures for each needed note that has no draft. These drafts are written by Landledger (`kind: template`). They
cite only figures the snapshot holds, so they always pass the check.

## Accepting, editing, rejecting

An analyst decides on the newest version of a note. An analyst is FP&A or a controller, and is never:

- the agent's sponsor;
- the person who wrote that version.

The analyst can do three things:

- **Accept** with `POST /api/notes/:id/accept {version}`. This writes `note.accepted` to the audit log and sends the
  `note.accepted` webhook.
- **Accept edited** with `{version, text}`. The edited text becomes a new version, written by the analyst, and that
  version is the one accepted.
- **Reject** with `POST /api/notes/:id/reject {version, reason}`. A new draft can follow.

Every version is kept, with:

- its writer;
- its agent and sponsor;
- its cites;
- the snapshot it was checked against;
- the decision on it.

Step 8 is done when every needed note on the current snapshot is accepted.

## Forecast history (spec 014)

Landledger stores the forecast to month-end once a day, in an hourly job, as a row in `forecast_history`. It stores
one row per cost center and one for `TOTAL`, each with P10, P50 and P90:

- **`TOTAL`** is Overview's forecast: P50 plus reservations, commitments and contracts, each netted against the run
  rate.
- **A cost center** takes the total band in proportion to its projected remainder.

The forecast on calendar day 10 is kept as it stood. Notes cite that forecast, so every note uses the same one.

At close, `GET /api/forecast/history?month=&costCenter=` measures the day-10 forecast against the snapshot's actual
and reports whether it was within ±10%.
