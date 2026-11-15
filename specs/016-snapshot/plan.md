# Plan: The frozen close snapshot (spec 016)

- `apps/api/src/snapshot.ts` (`Snapshots`: `ledgerFigures`, `freezeIn`, `current`, `view`); table `close_snapshots`.

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
