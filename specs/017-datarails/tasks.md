# Tasks: The Datarails connector against fake-datarails (spec 017)

- [x] The fake: MCP, upload, files list
- [x] Compose project landledger-fake
- [x] Connector: loopback guard, MCP client
- [x] Budget pull, accept, reject
- [x] Upload with hashes
- [x] Console page
- [x] Tests (the fake in-process)
- [x] docs/datarails.md

## Review of wave 4

- [x] R001 Should-fix 9: `redirect: 'error'`; loopback is only `127.0.0.1` and `::1`.
- [x] R002 Should-fix 13: one figure to book, `total_excl_notional`; notional, accrual and prepaid as memos.
- [x] R003 Nit: a pull that reaches 5,000 rows is refused, never kept cut short.
