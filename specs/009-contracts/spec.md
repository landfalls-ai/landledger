# Feature 009: Contracts and renewals (wave 3, "Plan and reconcile")

**Status**: specified 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · Screen:
`#contracts` in `ui/prototype.html`

## Why

SaaS contracts renew on their own unless someone gives notice in time. Finance needs every contract with its value,
term, seats paid and used, and its renewal and notice dates, with those inside the notice window first and a signal
before the notice date passes. A new contract is a commitment over its whole term and is approved as one.

## User stories

1. **As a controller**, I import contracts from a CSV and see them, renewals inside their notice window first.
2. **As a budget owner**, I hear (`contract.renewal_due`) when a contract of mine enters its notice window.
3. **As anyone raising one**, a contract request is for its total contract value and term, with seats as what it
   reserves.

## Acceptance

- **A contract**: vendor, product, cost center, total contract value (USD), term (start, end, months), annual value
  (TCV ÷ months × 12, half-even), seats paid and used, renewal date, notice days and notice date (renewal − notice
  days), auto-renew, the Landbright app it grants (optional). Versioned: a re-import of the same vendor and product is
  a new version; the newest wins.
- **CSV**: header `vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days`
  with optional `auto_renew` and `landbright_app`; USD only (422); every problem by line; a bad file imports nothing;
  a controller or the CFO, signed in.
- **Notice window**: from 30 days before the notice date (`LANDLEDGER_RENEWAL_WINDOW_DAYS`) to the renewal date.
  Inside it a contract is listed first, and webhook `contract.renewal_due` is sent once per contract and renewal date
  (the job runs hourly).
- **Contract requests**: kind `contract` with `contract: { vendor, product, tcv, termMonths, start, seats?,
  landbrightApp?, contractId? }`; its amount is the TCV, once; the policy (seeded): budget owner and Finance always,
  the CFO above $25,000. Approval reserves **seats**, never money: the contract (new or a new version) holds the
  seats; no monthly reservation of the TCV.
- **Seats left** = paid − used − reserved by approved seat requests not yet applied.
- `GET /api/contracts`, `GET /api/contracts/:id`, `POST /api/contracts/import`; console `#contracts`; renewals in
  Needs you.

## Out of scope

Invoices for SaaS (wave 5), the seats used from Landbright's grants (Landbright's side), price changes at renewal.
