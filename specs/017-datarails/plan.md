# Plan: The Datarails connector against fake-datarails (spec 017)

- `apps/fake-datarails` (TypeScript, no runtime dependencies; `deploy/compose.fake.yml`).
- `apps/api/src/datarails.ts` (`DatarailsClient`, `Datarails`); `Budgets.import` takes a source.
- Console: `routes/datarails.tsx` (Close → Datarails).

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
