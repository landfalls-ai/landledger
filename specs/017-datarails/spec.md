# Feature 017: The Datarails connector against fake-datarails (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/datarails.md](../../docs/datarails.md)

## Why

Budgets live in Datarails at most companies that use it, and actuals and notes go back to it at month-end. With no
tenant (decision 4), Landledger builds the connector against a fake shaped like the research found: a read-only MCP
server and the Data Gateway Service upload.

## User stories

1. **As the controller**, I pull the budget from Datarails; it waits as a pending change until a controller or the
   CFO accepts it, like a CSV import.
2. **As the controller**, at step 9 I upload the month's snapshot and accepted notes; Landledger keeps each file's
   hash and Datarails' answer.

## Acceptance

- `apps/fake-datarails` on :4819 (compose project `landledger-fake`): MCP over Streamable HTTP (JSON responses) with
  `list_data_models`, `list_aliased_fields`, `list_business_metrics`, `list_filebox`, `query_data_model`, bearer token;
  `POST /api/v1/fileboxes/upload_file` (multipart, Basic auth), `GET /api/v1/fileboxes/:id/files`; dev credentials.
- Pull: MCP calls, rows mapped by alias, checked like a budget CSV, staged with their sha256 and a preview; accept or
  reject by a controller or the CFO; accepted, a budget version with source `datarails`.
- Upload: actuals (invoiced as `actual`, estimated AI as `accrual`, cluster cost as `memo`) and notes from the
  snapshot; files' sha256, status and response kept; audited; `datarails.uploaded`.
- A host that isn't loopback is refused unless `LANDLEDGER_DATARAILS_REAL=true` (wave 5, the user's decision).

## Out of scope

A real tenant, OAuth per user, Datarails' commentary model.
