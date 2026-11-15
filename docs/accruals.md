# Accruals

This is wave 4, spec [013](../specs/013-accruals/spec.md). At month-end, Landledger proposes an accrual for the
costs it knows about but that haven't been invoiced yet. A controller accepts the proposal, and that accepts step 7
of the close ([close.md](close.md)).

The code is in `apps/api/src/accruals.ts` and the console page is at `/close/accruals`.

Accruals are never cost records, so no figure in Landledger adds them in. Landledger also never posts to a general
ledger (GL). It gives you the journal entry as a CSV, and the controller books it.

## The proposal

`POST /api/accruals/:month/propose` builds a proposal for a month that has ended. It has two kinds of lines:

- **Usage.** One line per AI provider, model and cost center. Each line accrues the estimates that the read rule still
  shows, meaning no invoice has replaced them yet. The line's basis is _estimated (usage × rate card), not yet
  invoiced_. It also counts how many estimates it covers.
- **Contract.** One line per contract that is in term during the month when its vendor has no invoice for that month.
  The line accrues the contract's value for the month: the value spread evenly over the term's days, exact to the
  micro-unit and rounded half-even. The cost center and P&L class come from the contract.

Who can do what with a proposal:

- **Proposing.** A controller, the CFO or FP&A, signed in, can propose. An API key gets 403.
- **Versions.** Each proposal is a new version. It supersedes a proposal nobody has accepted yet.
- **Accepting.** A controller accepts with `POST /api/accruals/:id/accept {sha256}`. The `sha256` is the hash of the
  lines as shown, so if the lines have changed since, the call returns 409. Steps 1–6 must be done or explained
  first.

In one transaction, accepting does four things:

- freezes the close snapshot (spec 016);
- writes `accrual.accepted` to the audit log;
- sends the `accrual.accepted` webhook;
- sends `notes.draft_requested` ([variance-notes.md](variance-notes.md)).

Once a proposal is accepted, proposing again returns 409. The exception is when the snapshot has gone out of date,
for example because a late invoice moved the reconciliation. Then a new accrual freezes a new snapshot.

## Reversal

A line is reversed in the month its invoice posts:

- **Usage lines** follow the same links that stop an estimate from counting beside its invoice (`invoice_estimate_links`).
  They share those links, so nothing counts twice.
- **Contract lines** reverse when the vendor's invoice for that month posts.

`GET /api/accruals?month=` shows each line's reversal: the invoice and the month the reversal is booked in. It also
lists `reversalsIn`, which are the earlier accrual lines reversed in this month.

## The journal entry

`GET /api/accruals/journal.csv?month=` returns a balanced journal entry with these columns: `journal_date`, `entry`,
`line`, `account`, `account_name`, `debit`, `credit`, `currency`, `cost_center`, `pl_class` and `memo`. It holds:

- the month's accepted accrual: a debit to technology expense by P&L class and cost center (`EXP-<CLASS>`), and a
  credit to `LIAB-ACCRUED` (_Accrued liabilities: technology_);
- the reversals booked in the month for earlier accruals whose invoices posted, as the opposite entries.

The account codes are placeholders. The controller maps them to the chart of accounts.
