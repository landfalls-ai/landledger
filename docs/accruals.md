# Accruals

This is wave 4, spec [013](../specs/013-accruals/spec.md). At month-end, Landledger proposes an accrual for the
costs it knows about but that haven't been invoiced yet. A controller accepts the proposal, and that accepts step 7
of the close ([close.md](close.md)).

The code is in `apps/api/src/accruals.ts` and `journal.ts`, and the console page is at `/close/accruals`.

Accruals are never cost records, so no figure in Landledger adds them in. Landledger also never posts to a general
ledger (GL). It freezes the journal when the accrual is accepted and gives it to you as a CSV, and the controller books
it.

## The proposal

`POST /api/accruals/:month/propose` builds a proposal for a month that has ended. It has two kinds of lines:

- **Usage.** One line per AI provider, model and cost center. Each line accrues the estimates that the read rule still
  shows, meaning no invoice has replaced them yet. The line's basis is _estimated (usage × rate card), not yet
  invoiced_. It also counts how many estimates it covers.
- **Contract.** By the contract's billing terms ([contracts.md](contracts.md#billing-terms); [plan.md](plan.md),
  Decision 11, a default to confirm):
  - **`monthly_in_arrears`** (the default): a `contract` line, the month's value, an accrued liability, until the
    vendor's invoice for the month posts (its newest version, not voided). When the vendor is also an AI provider
    (Anthropic, say) the line is net of that provider's usage lines, never below zero, so the same spend never
    accrues twice.
  - **`prepaid_annual`**: a `prepaid` line, the month's amortisation of a prepaid expense. It is reported apart
    (`prepaidTotal`) and is not in the accrual's `total`, which is the liability.
  - **`monthly_in_advance`**: nothing; the month was invoiced before it began.

  A month's value is the contract's value spread over the term's days, exact to the micro-unit and rounded half-even,
  computed as "value through the month's end less value through the day before", so the months always sum back to
  the contract's value. The cost center and P&L class come from the contract.

Who can do what with a proposal:

- **Proposing.** A controller, the CFO or FP&A, signed in, can propose. An API key gets 403.
- **Versions.** Each proposal is a new version. It supersedes a proposal nobody has accepted yet.
- **Accepting.** A controller accepts with `POST /api/accruals/:id/accept {sha256}`. The `sha256` is the hash of the
  lines as shown, so if the lines have changed since, the call returns 409. Landledger also derives the lines again
  as it accepts: if an invoice (or a late call) changed them since the proposal, it answers 409 `lines changed since
  v<n> was proposed` (review of wave 4, B2). The round must be started, and steps 1–6 done or explained, first. An
  account that looks like a service never accepts (403).

In one transaction, accepting does five things:

- freezes the close snapshot (spec 016);
- freezes the month's journal (below);
- writes `accrual.accepted` to the audit log;
- sends the `accrual.accepted` webhook;
- sends `notes.draft_requested` ([variance-notes.md](variance-notes.md)).

Once a proposal is accepted, proposing again returns 409. The exceptions: the snapshot has gone out of date, for
example because a late invoice moved the reconciliation (then a new accrual freezes a new snapshot), or the accepted
version was accepted by an account that looks like a service, before the review of wave 4 refused one (then a named
controller accepts the month again; step 7 is red until then).

## Reversal

A line is reversed in the month its invoice posts, dated the day it posted in `LANDLEDGER_TZ` (review of wave 4,
should-fix 10):

- **Usage lines** follow the same links that stop an estimate from counting beside its invoice (`invoice_estimate_links`),
  but only a link to an invoiced entry still live, of an invoice whose newest version is posted. They share those
  links, so nothing counts twice.
- **Contract lines** (in arrears) reverse when the vendor's invoice for that month posts, judged by its newest
  version.
- **A voided invoice reverses nothing.** Import and void on 2 November, and nothing is reversed; the real invoice in
  December reverses the lines. A reversal is dated by the invoice's first posting after its last void. Dev fixtures
  reverse nothing.
- **Prepaid lines** are never reversed: they are amortisation, not a liability.

`GET /api/accruals?month=` shows each line's reversal: the invoice and the month the reversal is booked in. It also
lists `reversalsIn`, which are the earlier accrual lines reversed in this month.

## The journal

**The journal is frozen** when a controller accepts the month's accrual, in the same transaction (review of wave 4,
should-fix 11; `journal_lines`, append only). `GET /api/accruals/journal?month=` returns it (`JournalView`), and
`GET /api/accruals/journal.csv?month=` as a CSV with the columns `entry_id`, `line`, `journal_date`, `kind`,
`gl_account`, `gl_name`, `account`, `account_name`, `debit`, `credit`, `currency`, `cost_center`, `pl_class`, `memo`,
`frozen` and `coa_version`. Before acceptance, both show what accepting would freeze now (`frozen: false`).

- **Entry ids** run per month: `JE-2026-10-0001`, `JE-2026-10-0002`, … Each entry balances.
- **Kinds.** `accrual` (debit technology expense by P&L class and cost center, credit `LIAB-ACCRUED`); `prepaid`
  (debit expense, credit `ASSET-PREPAID`); `supersede`, the mirror of an earlier accepted version's entry when a
  later version replaces it, so a controller who booked v1 gets its reversing entry; and `reversal`, the opposite of
  an earlier month's accrual line when its invoice posts, booked in the month it posted.
- **To the cent.** An entry's lines are posted to the cent by largest remainder, so the entry equals the accepted
  total posted, never a cent off from per-line rounding.
- **Versions accepted before the journal existed** were booked from the CSV: the first freeze writes their entry as
  booked (memo _Accepted before the journal was frozen, as booked from its CSV_), then supersedes it.
- **A month reopened after the next froze its reversals.** A line the next month already reversed holds nothing to
  supersede: it is carried as it was booked, and a later version's same line isn't accrued again.

### The chart of accounts

Each journal line carries the placeholder account (`LIAB-ACCRUED`, `ASSET-PREPAID`, `EXP-<CLASS>`) and the general
ledger's account and name from the **mapping** version in force when it was frozen. A frozen line keeps its mapping.

- `GET /api/coa` lists the mapping versions (`CoaMappingViews`). Version 1 is a default (2150 accrued liabilities,
  1450 prepaid expenses, 5100–6599 expense by P&L class), a placeholder for the controller to replace.
- A controller changes it with `POST /api/coa/proposals {mapping, note}`: every account mapped, one proposal pending
  at a time. That raises a `coa_mapping_change` request (`pol_coa_mapping_1`): a controller or the CFO who didn't
  propose it decides. Approved, it becomes the mapping for every journal frozen after.

## The roll-forward

`GET /api/accruals/roll-forward?month=` (`AccrualRollForward`) reads the accrued liability from the journal: the
**opening** balance (every earlier month), **additions**, **superseded** (earlier versions replaced), **reversals**
(invoices posted) and the **closing** balance, with `opening + additions − superseded − reversals = closing`. It lists
each line still open with its age, in four buckets (accrued this month, 1, 2, and 3 or more months old), and the
prepaid amortised in the month. November's opening is October's closing.

## Time zone

A month ends, and a reversal is dated, in `LANDLEDGER_TZ`, as invoices are.
