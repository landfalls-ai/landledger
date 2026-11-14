# Landledger docs

| Page | What it covers |
|---|---|
| [plan.md](plan.md) | The waves, the principles, sibling changes, measures, open decisions |
| [architecture.md](architecture.md) | Processes, code map, data, jobs, the land family's interfaces, controls |
| [development.md](development.md) | Setup, ports, commands, where each area's code starts, conventions, how to check a change |
| [money.md](money.md) | Micro-units, the two rounding modes, splits, FX, records and corrections, periods |
| [reference/api.md](reference/api.md), [reference/env.md](reference/env.md) | Every route and every environment variable |
| [ui.md](ui.md) | The console's screens and the rules they follow; `../ui/prototype.html` is the clickable version |
| [research.md](research.md) | Wave 0's study on one page: what OpenCost and FOCUS 1.4 teach, what the sources give today, the decisions (D1–D15) and what is still open |
| [research/opencost.md](research/opencost.md) | OpenCost v1.121.3 read by file and line: the cost model, max(request, usage), idle, shared cost, custom pricing, the API, what Landledger takes, changes or rejects |
| [research/focus.md](research/focus.md) | FOCUS 1.4: the 45 columns kept and the ones dropped, estimated against invoiced, AI tokens as rows, corrections, the `x_` columns, periods |
| [../specs/](../specs/) | Feature specs (spec, plan, tasks): [001 money and records](../specs/001-money-and-records/spec.md), [002 ingest and pricing](../specs/002-ingest/spec.md), [003 allocation](../specs/003-allocation/spec.md) |
| [../study/README.md](../study/README.md) | The study's outputs: OpenCost's source graphs (Craft Anything) and the read-only probe of Clickland's metrics, and how to re-create them |
| [history.md](history.md) | Every change, in order |

The readable page with the diagrams and screenshots is `../ui/plan.html` (published at https://claude.ai/artifact/SPq2ui6QtGsdCiBCvA7vV5); `ui/shoot.cjs` retakes the screenshots with Playwright.

`scripts/fetch-upstream.sh` fetches the pinned sources the research cites into `upstream/` (git-ignored); `scripts/fetch-tools.sh` fetches Craft Anything into `tools/craft-anything/`.
