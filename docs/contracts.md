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
| Term | Start and end (inclusive) and its months (`termMonths`, whole months, at least 1, as shown) |
| Annual value | TCV × 12 ÷ the exact months (whole months plus the days of a part month over its days, so an 11.5-month term is not rounded to 11), half-even |
| Seats paid, used | As imported, as of `seats_used_as_of` (or the import day); _used_ also counts seats granted through Landledger after that day (below) |
| Seat price | Annual value ÷ seats paid ÷ 12: what one seat costs a month on this contract |
| Renewal date, notice days | `noticeCalendarDate` = renewal − notice days; `noticeDate`, the one acted on, is the last business day on or before it (`LANDLEDGER_BUSINESS_DAYS`, `LANDLEDGER_HOLIDAYS`) |
| Covered | An `entered` contract an approved contract request covers (its origin request, or one for the vendor and product with a TCV at least as high); if not, it is on the exceptions report |
| Auto-renew | Whether it renews itself (default true) |
| Billing | `monthly_in_arrears` (default), `monthly_in_advance` or `prepaid_annual`: how the vendor bills, which decides what the month-end accrual does with it ([below](#billing-terms)) |
| Landbright app | The app in Landbright a seat on this contract grants (optional): how Landflow finds the contract for an access request |
| Origin | `entered`, `dev-fixture` (labelled _dev fixture_ everywhere) or `request` (made by an approved contract request) |

Contracts are **append only**: importing the same vendor and product again, or approving a contract request that
renews one, writes a new version (`contract_versions`); the newest wins, and the older ones stay. Each import is
audited `contract.imported` or `contract.reimported`.

## Import

`POST /api/contracts/import` `{ csv, fileName?, note?, origin? }`, by the controller or the CFO, signed in (a key never
imports; 403). The header:

```
vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days[,auto_renew,landbright_app,seats_used_as_of,billing]
```

`billing` is optional; an empty cell, or a file without the column, is `monthly_in_arrears`. A new version without it
keeps the contract's terms.

`seats_used_as_of` (a date, not after today, only with `seats_used`) is the day the seats-used figure was taken: seats
Landledger saw granted after it are added, and ones granted before it are not counted twice (should-fix 5). Without
it, the import's own day (in `LANDLEDGER_TZ`) is used. The contract CSV export carries it.

**A second person above $25,000** (Decision 9, should-fix 6). A new contract with a TCV over $25,000, or a version
raising a contract's TCV by more than that, is not entered: it is held as a pending `contract` request (origin
`contract_import`, with the file name, the line and the TCV it raises), raised in the importer's name, so the owner,
Finance and the CFO decide it and the importer can't. Audited `contract.import_held`; `GET /api/contracts` lists them
under `held`. Approving it records the contract. A smaller import enters at once and stays on the exceptions report
(`contracts`) until an approved contract request covers it. A caller can't claim the `contract_import` origin.
`origin: dev-fixture` is for a development API only (`LANDLEDGER_DEV_AUTH=on` on this machine; 403 otherwise), never
held, and counted in no total.

USD only: another currency is `422` and nothing is imported. Every problem is reported by line (an unknown cost
center, a bad amount or date, an end or renewal before the start, seats paid without seats used, a notice over 365
days, a term over 120 months, the same vendor and product twice in the file),
and a file with any problem imports nothing (`400` with `details.problems`). The dev fixture is
`apps/api/fixtures/contracts/contracts-2026.dev.csv`: Linear Business (ENG-PRODUCT, $9,600 a year, 40 seats, renews
1 January 2027 with 30 days' notice) and Notion Team (GA-IT, $4,800, 30 seats, renews 1 June 2027 with 60 days').

## Renewals

A contract is **inside its notice window** from `LANDLEDGER_RENEWAL_WINDOW_DAYS` (30) days before its notice date to
its renewal date. Inside it, the contract comes first on the Contracts page (by notice date) and in Overview's **Needs
you** (_Renewal: Linear Business, notice by 2 December_). "Today" is the date in `LANDLEDGER_TZ` (should-fix 15). The
hourly `renewals` job sends, each once per contract and renewal date and audited by its own name:

| Webhook | When |
|---|---|
| `contract.renewal_due` `{ contract, url }` | on entering the window (`contract_alerts`) |
| `contract.notice_reminder` | 7 days and again 1 day before the notice date (`contract_notices`) |
| `contract.notice_missed` | the day after the notice date when no contracts file has come in since (the renewal will happen) |

A renewed contract (a new version with a later renewal date) is due again at its own window.

## A contract request

Kind `contract`, with `contract: { vendor, product, tcv, termMonths, start, seats?, noticeDays?, autoRenew?,
landbrightApp?, contractId? }`. Its amount must be the TCV and its recurrence `once` (400 otherwise). The seeded
`contract` policy (decision 9, a default to confirm): the cost center's owner and Finance always, the CFO above
$25,000. A contract request is never approved by policy alone: approval records the contract, and that is a person's.

Its terms may also carry `termEnd`, `renewalDate`, `seatsUsed` and `seatsUsedAsOf` (a held import's do); a `termEnd`
before the start is refused.

On approval the request **reserves no money**: a contract is a commitment over its term, not a month's spend, so its
TCV is not held against any month's budget. Instead the contract is recorded as a version (`origin: request`, a new
contract or, with `contractId`, a new version of the one it renews): term from `start` for `termMonths`, renewal the
day after the term ends, the seats paid, none used yet. Audited `contract.from_request`.

## Billing terms

Review of wave 4, should-fix 12; [plan.md](plan.md), Decision 11, a default to confirm with Finance per vendor. The
month-end accrual ([accruals.md](accruals.md#the-proposal)) reads them:

| Billing | The month-end accrual |
|---|---|
| `monthly_in_arrears` | Accrues the month's value as a liability until the vendor's invoice for the month posts; net of the vendor's own AI usage lines when it is also an AI provider |
| `prepaid_annual` | Amortises the month's value as a prepaid expense line, reported apart from the liability |
| `monthly_in_advance` | Nothing: the month was invoiced before it began |

`GET /api/contracts` carries each contract's terms (`ContractView.billing`).

## A seat (tool or seat)

Kind `tool_or_seat`, with `seat: { contractId, seats (1–100, default 1), seatPrice }`. The amount must be seats ×
seat price, monthly (400 otherwise: "seats × seat price a month: 1 × 20 = 20.000000"). The contract must exist, and
the seat price can't be below the contract's own (400, should-fix 4). A request that would leave no seat on the
contract is never approved by policy, whatever its amount: a person decides it.

- **Evidence** (`evidence.seat`): the contract (vendor, product, renewal), seats paid, used and reserved, left now and
  left after this request, the seat price asked and the contract's own, and a note when none is left: _No seat is
  left on Linear Business: approving buys a seat beyond the contract (40 paid)_. The approver decides with that in
  front of them.
- **On approval:** the seats are reserved on the contract (`seat_reservations`, `reserved`). Seats the contract still
  has paid and free reserve **no money** (wave 4, [spec 020](../specs/020-seat-within-contract/spec.md)): the
  contract's value is already in the forecast as _contracted_, so the seat price would count twice. Such a request
  shows as _within contract_ (`RequestSummary.withinContract`): it adds nothing to the evidence, budgets, commitments
  or the year ahead, and `POST /api/reservations` for it is a 409.
- **Seats beyond the contract** (review of wave 4, should-fix 14) reserve money: the seats no paid seat covers
  (`seat.beyond`, counted when the request is made and again as each approval lands) × the seat price a month, in
  budgets, commitments and the year ahead. Such a request is not _within contract_. `request.decided` carries `request.seat` (`{ contractId, vendor, product, seats,
  seatPrice, status }`) so Landflow can answer Landbright without another call.
- **On applied** (`POST /api/requests/:id/applied`, after Landbright granted): the reservation is `applied` and counts
  as used.
- Rejected, cancelled or expired: nothing is reserved.
- **Released** (should-fix 5): `POST /api/requests/:id/seats/release { reason, note? }`, by the creating key, the
  requester (or sponsor) or an admin person, when Landbright denied access (`access_denied`), revoked the grant
  (`grant_revoked`, the only reason for an applied seat) or it isn't needed (`not_needed`). The seat goes back to the
  contract, the request's reservations are released, audited `seat.released`, webhook `seat.released` `{ requestId,
  number, contractId, seats, reason, from, url }`. A seat approved and not applied within 30 days is released by the
  hourly job (`expired`). A second release is a 409.

Seats left = paid − used − reserved, where used = seats used as of its date + seats applied after that day − seats
released since that had been applied by then.

`GET /api/contracts/seats?landbrightApp=linear` (scope `read`) returns the contract that grants the app, its seat
price and seats left; `404` when no contract names the app. The steps Landflow and Landbright take are in
[integrations.md](integrations.md#tool-or-seat-spec-010).

## Not yet

SaaS invoices against contracts (wave 5); seats used read live from Landbright's grants (Landbright's side, see
integrations.md); price changes at renewal (a new version with the new TCV is how it is entered today). A seat
request's monthly amount and the contract's value both sit in the forecast, so a seat bought on a contract already
counted may be counted twice there (open).
