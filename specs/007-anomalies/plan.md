# Plan 007: Anomalies

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/schema` | `0012_wave3.sql`: `anomalies` (unique per kind, rule, dimension, key, window), `anomaly_acks`; source `dev-anomaly` allowed on `cost_records`, `provisional_usage` and `ingest_runs` |
| `libs/focus` | `dev-anomaly` in `SOURCES` |
| `libs/contracts` | `AnomalyView`, webhook payloads `cost.anomaly`, `approval.anomaly` |
| `apps/api` | `anomalies.ts` (robust stats, both detectors, the job, acknowledge, the dev spike), `cli.ts` (`anomaly spike|reverse|scan|clickland-alert`), `clickland.ts` (the alert rule) |
| `apps/console` | `routes/anomalies.tsx`; Needs you on Overview |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Anomalies decide nothing; acknowledging is a person's. |
| 2. Estimated or invoiced | PASS | Each anomaly says the basis of the figures it compares. |
| 3. Money is exact | PASS | Median and MAD in micro-units (an even count's median rounds half-even). |
| 4. Nothing is edited | PASS | Anomalies and acknowledgements append only; the dev spike is reversed, never deleted. |
| 5. Nobody depends on it | PASS | Webhooks and Clickland log records are fire-and-forget. |
| 6. Local only | PASS | The dev spike is refused unless `LANDLEDGER_DEV_ANOMALY=on`. |
| 7. Spec-driven | PASS | This spec. |

## Clickland

Clickland's alerts count rows of logs or traces that match a search; they don't threshold a metric's value, so a
rule on `landledger.cost.*` doesn't fit. Landledger posts each anomaly as a log record (pino through OpenTelemetry,
`landledger.event: cost.anomaly`, `landledger.cost_center`, `landledger.dimension`, `landledger.key`) and the
installed rule counts them: `service:landledger-api landledger.event:cost.anomaly`, above 0 in 60 minutes, grouped by
`landledger.key`. What Clickland would add to watch the metrics directly is in `docs/integrations.md`.
