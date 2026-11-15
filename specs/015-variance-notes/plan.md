# Plan: Variance notes (spec 015)

- Tables `variance_notes`, `variance_note_versions`, `variance_note_decisions`, `notes_requests` (0014).
- `apps/api/src/notes.ts` (`Notes`): figures, draft, template, accept, reject, list; `templateNote` is pure.
- Console: `routes/notes.tsx` (Close → Variance notes).

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
