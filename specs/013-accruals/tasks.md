# Tasks: Accruals (spec 013)

- [x] Proposal from the read rule's estimates and contracts
- [x] Accept with sha256 and the snapshot freeze
- [x] Reversals through the invoice links
- [x] Journal entry CSV
- [x] Console page
- [x] Tests: proposal, accept, reversal, balanced JE
- [x] docs/accruals.md

## Review of wave 4

- [x] R001 B2: accepting derives the lines again; a difference since the proposal is a 409.
- [x] R002 Should-fix 10: reversal only by a live link to an invoice whose newest version is posted; a void reverses
  nothing; dated in `LANDLEDGER_TZ`.
- [x] R003 Should-fix 11: the journal frozen at acceptance (`journal_lines`): entry ids, supersede entries, posted to
  the cent by largest remainder; a chart-of-accounts mapping changed by request; the roll-forward with aging.
- [x] R004 Should-fix 12: contract billing terms; only in-arrears accrues, net of the vendor's usage lines; prepaid
  amortises apart; in-advance accrues nothing; months sum to the contract's value.
- [x] R005 Nits: the page's $0 wording; earlier versions exclude the current one.
