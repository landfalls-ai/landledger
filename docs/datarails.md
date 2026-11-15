# Datarails

This page covers wave 4, spec [017](../specs/017-datarails/spec.md). Landledger connects to Datarails in two
directions:

- **Budgets in.** Budgets are read over MCP and become a pending change that a person accepts.
- **Actuals and notes out.** These are sent through the FileBox upload API.

Wave 4 builds the connector only against `fake-datarails`, which runs on this machine. A real tenant is wave 5 and
your decision.

| What | Where |
|---|---|
| Connector code | `apps/api/src/datarails.ts` |
| Fake code | `apps/fake-datarails/` |
| Console page | `/close/datarails` |

## A real tenant stays off

The connector refuses any host that isn't loopback (127.0.0.1, ::1, localhost). The refusal is a 503 that names wave
5. It is lifted only by setting `LANDLEDGER_DATARAILS_REAL=true`.

The development credentials are the default only when both URLs are loopback. A remote URL needs its own
`LANDLEDGER_DATARAILS_*` settings ([reference/env.md](reference/env.md)).

## fake-datarails

The fake runs as compose project `landledger-fake` at `http://127.0.0.1:4819`:

```bash
pnpm fake:up
pnpm fake:down
```

`pnpm fake:up` runs `COMPOSE_BAKE=false docker --context orbstack compose -p landledger-fake -f deploy/compose.fake.yml up -d --build --wait`.
Its files live in the `datarails-data` volume.

It has two surfaces, the two the connector uses:

- **`POST /mcp`.** An MCP server (JSON-RPC 2.0 over streamable HTTP) with Bearer auth.
  - It offers only read tools: `list_data_models`, `list_aliased_fields`, `list_business_metrics`,
    `query_data_model` and `list_filebox`.
  - Its budget model `dm_budget_fy27` returns rows keyed by field ids (`f_1001`…`f_1006`), as Datarails does.
    `list_aliased_fields` names those fields.
  - It holds two scenarios, _Budget FY27_ and _Reforecast Q1_. Each has 7 cost centers × December 2026 to March 2027.
- **`POST /api/v1/fileboxes/upload_file`.** The FileBox upload: multipart, with Basic auth.
  - The fake keeps each file on disk and answers with an `upload_id` and each file's sha256.
  - `GET /api/v1/fileboxes/:id/files` lists the files.

None of these shapes is a real Datarails API contract. They are close enough to exercise the connector.

## Budgets in

`POST /api/datarails/budgets/pull {dataModel, scenario}` is open to a controller or the CFO, signed in. Each pull
runs these steps:

1. It calls `initialize`.
2. It finds the model with `list_data_models` and maps its fields to cost center, month and amount with
   `list_aliased_fields`.
3. It reads the rows with `query_data_model`.

The pull is stored as **pending**, with:

- the sha256 of the rows as received;
- the months it covers;
- its total;
- a preview against the budget in effect now.

Rows that repeat a cost center and month are refused with 422 and _name a scenario_.

A pending pull changes nothing until a controller or the CFO decides on it.

- **Accept** with `POST /api/datarails/budgets/pulls/:id/accept {sha256}`. This is the same approval as a CSV budget
  import: the rows become the next budget version, with source `datarails`. A locked month's budget is refused with
  409.
- **Reject** with `…/reject {reason}`.

## Actuals and notes out (step 9)

`POST /api/datarails/uploads {month}` sends three files from the frozen snapshot to the filebox (`LANDLEDGER_DATARAILS_FILEBOX`):

| File | Holds |
|---|---|
| `landledger-actuals-<month>.csv` | Per cost center: `estimated`, `invoiced`, `notional` (cluster cost from Clickland, never actuals), `total`, the accepted `accrual`, `budget`, `currency`, and the snapshot's sha256 on every row |
| `landledger-notes-<month>.csv` | The accepted variance notes: cost center, version, who accepted it and when, the snapshot's sha256, the text |
| `landledger-snapshot-<month>.json` | The snapshot's canonical JSON |

The upload records several things in `datarails_uploads`, even when it fails:

- the sha256 and row count of each file;
- the HTTP status;
- the response as received.

It also writes `datarails.uploaded` to the audit log and sends the `datarails.uploaded` webhook.

Step 9 is done when an upload of the current snapshot succeeded after the notes were accepted.
