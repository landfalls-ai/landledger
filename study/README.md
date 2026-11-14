# Study: what the tools recorded

Evidence behind `docs/research/`. Every file here was written by a tool, not by hand.

| Path | What | How it was made |
|---|---|---|
| `opencost-source-graph/` (git-ignored) | Craft Anything source graphs of OpenCost's allocation and pricing code (`core/pkg/opencost`, `core/pkg/pricing`, `core/pkg/source`, `pkg/costmodel`, `pkg/cloud/provider`, `pkg/currency`, `pkg/customcost`, `pkg/inferencecost`) and of the OpenCost UI (`app/`): every file with its sha256 and language, and for TypeScript its exports, imports and functions | Craft Anything 0.6.1 `app_source_import`, Deep mode (open-source code), `scripts/study-source-graph.sh` |
| `opencost-source-graph.md` | The index of those graphs: each graph's id, file count and languages; for Go files (Craft Anything extracts symbols only for JavaScript and TypeScript) the top-level `func` lines with line numbers, checked against the graph's sha256 | `scripts/study-source-index.py`, run by `scripts/study-source-graph.sh` |
| `clickland-live/probe.md` | Which Kubernetes and container metrics Clickland's ClickHouse holds, how often they are sampled, and requested, used and max(request, usage) core-hours for two hours of the OrbStack cluster | `scripts/study-clickland-probe.sh`: read-only `clickhouse-client` against `clickland-infra-clickhouse-1` |

Re-create everything with:

```bash
scripts/fetch-upstream.sh          # OpenCost v1.121.3, OpenCost UI v1.121.2, FOCUS v1.4 into upstream/
scripts/fetch-tools.sh             # Craft Anything 0.6.1, checksum and code signature checked
scripts/study-source-graph.sh      # study/opencost-source-graph/ and its index
scripts/study-clickland-probe.sh   # needs Clickland's infra running on OrbStack
```
