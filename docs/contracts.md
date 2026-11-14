# Contracts, renewals and seats

Wave 3, [spec 009](../specs/009-contracts/spec.md) and [spec 010](../specs/010-tool-or-seat/spec.md). SaaS contracts
renew on their own unless someone gives notice in time, and a paid seat is spend. Landledger keeps every contract with
its value, term, seats and dates, shows the renewals inside their notice window first, approves a new contract for its
whole value and term, and approves a seat on a contract as a request before Landbright grants it.
`apps/api/src/contracts.ts`, `GET /api/contracts`, the console's **Control → Contracts**.

## A contract

| Field | What it is |
|---|---|
| Vendor, product | Together they name the contract: `con_…` is stable across versions |
| Cost center | Who pays; its owner hears of the renewal |
| Total contract value (TCV) | USD over the whole term, in micro-units |
| Term | Start and end (inclusive) and its months (`termMonths`, whole months, at least 1) |
| Annual value | TCV × 12 ÷ months, half-even |
| Seats paid, used | As imported; _used_ also counts seats granted through Landledger since (below) |
| Seat price | Annual value ÷ seats paid ÷ 12: what one seat costs a month on this contract |
| Renewal date, notice days | Notice date = renewal − notice days |
| Auto-renew | Whether it renews itself (default true) |
| Landbright app | The app in Landbright a seat on this contract grants (optional): how Landflow finds the contract for an access request |
| Origin | `entered`, `dev-fixture` (labelled _dev fixture_ everywhere) or `request` (made by an approved contract request) |

Contracts are **append only**: importing the same vendor and product again, or approving a contract request that
renews one, writes a new version (`contract_versions`); the newest wins, and the older ones stay. Each import is
audited `contract.imported` or `contract.reimported`.

## Import

`POST /api/contracts/import` `{ csv, fileName?, note?, origin? }`, by the controller or the CFO, signed in (a key never
imports; 403). The header:

```
vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days[,auto_renew,landbright_app]
```

USD only: another currency is `422` and nothing is imported. Every problem is reported by line (an unknown cost
center, a bad amount or date, an end or renewal before the start, seats paid without seats used, a notice over 365
days, a term over 120 months, the same vendor and product twice in the file),
and a file with any problem imports nothing (`400` with `details.problems`). The dev fixture is
`apps/api/fixtures/contracts/contracts-2026.dev.csv`: Linear Business (ENG-PRODUCT, $9,600 a year, 40 seats, renews
1 January 2027 with 30 days' notice) and Notion Team (GA-IT, $4,800, 30 seats, renews 1 June 2027 with 60 days').

## Renewals

A contract is **inside its notice window** from `LANDLEDGER_RENEWAL_WINDOW_DAYS` (30) days before its notice date to
its renewal date. Inside it, the contract comes first on the Contracts page (by notice date) and in Overview's **Needs
you** (_Renewal: Linear Business, notice by 2 December_). The hourly `renewals` job sends webhook
`contract.renewal_due` `{ contract, url }` once per contract and renewal date (`contract_alerts`), audited
`contract.renewal_due`. A renewed contract (a new version with a later renewal date) is due again at its own window.

## A contract request

Kind `contract`, with `contract: { vendor, product, tcv, termMonths, start, seats?, noticeDays?, autoRenew?,
landbrightApp?, contractId? }`. Its amount must be the TCV and its recurrence `once` (400 otherwise). The seeded
`contract` policy (decision 9, a default to confirm): the cost center's owner and Finance always, the CFO above
$25,000. A contract request is never approved by policy alone: approval records the contract, and that is a person's.

On approval the request **reserves no money**: a contract is a commitment over its term, not a month's spend, so its
TCV is not held against any month's budget. Instead the contract is recorded as a version (`origin: request`, a new
contract or, with `contractId`, a new version of the one it renews): term from `start` for `termMonths`, renewal the
day after the term ends, the seats paid, none used yet. Audited `contract.from_request`.

## A seat (tool or seat)

Kind `tool_or_seat`, with `seat: { contractId, seats (1–100, default 1), seatPrice }`. The amount must be seats ×
seat price, monthly (400 otherwise: "seats × seat price a month: 1 × 20 = 20.000000"). The contract must exist.

- **Evidence** (`evidence.seat`): the contract (vendor, product, renewal), seats paid, used and reserved, left now and
  left after this request, the seat price asked and the contract's own, and a note when none is left: _No seat is
  left on Linear Business: approving buys a seat beyond the contract (40 paid)_. The approver decides with that in
  front of them.
- **On approval:** the seat price is reserved monthly like any request, and the seats are reserved on the contract
  (`seat_reservations`, `reserved`). `request.decided` carries `request.seat` (`{ contractId, vendor, product, seats,
  seatPrice, status }`) so Landflow can answer Landbright without another call.
- **On applied** (`POST /api/requests/:id/applied`, after Landbright granted): the reservation is `applied` and counts
  as used.
- Rejected, cancelled or expired: nothing is reserved.

Seats left = paid − used − reserved, where used = seats used as imported + seats applied since that version was
imported. Re-importing a contract with a fresh _seats used_ resets that count, since the new figure includes them.

`GET /api/contracts/seats?landbrightApp=linear` (scope `read`) returns the contract that grants the app, its seat
price and seats left; `404` when no contract names the app. The steps Landflow and Landbright take are in
[integrations.md](integrations.md#tool-or-seat-spec-010).

## Not yet

SaaS invoices against contracts (wave 5); seats used read live from Landbright's grants (Landbright's side, see
integrations.md); price changes at renewal (a new version with the new TCV is how it is entered today).
