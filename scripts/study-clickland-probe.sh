#!/usr/bin/env bash
# Read-only probe of Clickland's ClickHouse (clickland-infra on OrbStack): which Kubernetes and container metrics a
# usage rollup can be built from, how often they are sampled, and what requested / used / max(request, usage)
# core-hours look like for the last two full hours. Writes study/clickland-live/probe.md.
# Uses Clickland's development admin credentials (its deploy/compose.infra.yml default) with --readonly 1.
set -euo pipefail
cd "$(dirname "$0")/.."
CH=${CLICKLAND_CH_CONTAINER:-clickland-infra-clickhouse-1}
PW=${CLICKLAND_CH_ADMIN_PASSWORD:-clickland-dev-admin}
mkdir -p study/clickland-live
q() {
  printf '\n```sql\n%s\n```\n\n```\n' "$1"
  docker --context orbstack exec "$CH" clickhouse-client --user clickland_admin --password "$PW" --readonly 1 \
    -q "$1 FORMAT PrettyCompactMonoBlock" 2>&1 || true
  printf '```\n'
}
W="TimeUnix >= toStartOfHour(now()) - INTERVAL 2 HOUR AND TimeUnix < toStartOfHour(now())"
{
  echo "# Clickland live probe: the metrics a usage rollup can be built from"
  echo
  echo "Read-only queries (\`clickhouse-client --readonly 1\`) against \`$CH\` on OrbStack at $(date -u +%Y-%m-%dT%H:%MZ)."
  echo "Written by \`scripts/study-clickland-probe.sh\`; nothing here was typed by hand."
  echo
  echo "## 1. Kubernetes and container metrics in the last day (gauges, then sums)"
  q "SELECT MetricName, any(MetricUnit) AS unit, count() AS points, uniqExact(ResourceAttributes['k8s.pod.name']) AS pods, min(TimeUnix) AS first_seen FROM clickland.otel_metrics_gauge WHERE (MetricName LIKE 'k8s.%' OR MetricName LIKE 'container.%') AND TimeUnix > now() - INTERVAL 1 DAY GROUP BY MetricName ORDER BY MetricName"
  q "SELECT MetricName, any(MetricUnit) AS unit, any(AggregationTemporality) AS temporality, any(IsMonotonic) AS monotonic, count() AS points FROM clickland.otel_metrics_sum WHERE (MetricName LIKE 'k8s.%' OR MetricName LIKE 'container.%') AND TimeUnix > now() - INTERVAL 1 DAY GROUP BY MetricName ORDER BY MetricName"
  echo
  echo "## 2. Pod network and volume metrics, all time (empty: none stored)"
  q "SELECT MetricName, count() AS points FROM clickland.otel_metrics_sum WHERE MetricName IN ('k8s.pod.network.io', 'k8s.pod.network.errors') OR MetricName LIKE 'k8s.volume.%' GROUP BY MetricName"
  q "SELECT MetricName, count() AS points FROM clickland.otel_metrics_gauge WHERE MetricName LIKE 'k8s.volume.%' OR MetricName LIKE 'k8s.persistentvolume%' GROUP BY MetricName"
  echo
  echo "## 3. Sampling interval (seconds between points of one series, last two hours)"
  q "SELECT MetricName, round(avg(gap), 1) AS avg_gap_s, min(gap) AS min_gap_s, max(gap) AS max_gap_s FROM (SELECT MetricName, ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, dateDiff('second', lagInFrame(TimeUnix) OVER (PARTITION BY MetricName, pod, c ORDER BY TimeUnix ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), TimeUnix) AS gap FROM clickland.otel_metrics_gauge WHERE MetricName IN ('k8s.container.cpu_request', 'container.cpu.usage', 'k8s.container.memory_request', 'container.memory.working_set', 'k8s.node.allocatable_cpu') AND TimeUnix > now() - INTERVAL 2 HOUR) WHERE gap > 0 AND gap < 3600 GROUP BY MetricName ORDER BY MetricName"
  echo
  echo "## 4. The attributes a rollup would group by (one container's request series)"
  q "SELECT ResourceAttributes FROM clickland.otel_metrics_gauge WHERE MetricName = 'k8s.container.cpu_request' AND TimeUnix > now() - INTERVAL 1 HOUR LIMIT 1"
  echo
  echo "## 5. Two full hours as a rollup would see them: core-hours requested, used and max(request, usage)"
  echo
  echo "Request (k8s_cluster) and usage (kubelet_stats) come from two receivers on their own clocks, so samples are"
  echo "averaged per container and minute, then joined; a minute is 1/60 of an hour. Minutes with no request sample"
  echo "(a container without a request, or a gap) are missing from the left side."
  q "WITH req AS (SELECT ResourceAttributes['k8s.namespace.name'] AS ns, ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, toStartOfMinute(TimeUnix) AS m, avg(Value) AS v FROM clickland.otel_metrics_gauge WHERE MetricName = 'k8s.container.cpu_request' AND $W GROUP BY ns, pod, c, m), use AS (SELECT ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, toStartOfMinute(TimeUnix) AS m, avg(Value) AS v FROM clickland.otel_metrics_gauge WHERE MetricName = 'container.cpu.usage' AND $W GROUP BY pod, c, m) SELECT req.ns AS namespace, round(sum(req.v) / 60, 4) AS requested_core_h, round(sum(use.v) / 60, 4) AS used_core_h, round(greatest(sum(req.v), sum(use.v)) / 60, 4) AS max_of_sums_core_h, round(sum(greatest(req.v, use.v)) / 60, 4) AS sum_of_max_core_h FROM req LEFT JOIN use ON req.pod = use.pod AND req.c = use.c AND req.m = use.m GROUP BY namespace ORDER BY sum_of_max_core_h DESC LIMIT 15"
  q "SELECT MetricName, round(avg(Value) / if(MetricName = 'k8s.node.allocatable_memory', pow(1024, 3), 1), 3) AS allocatable_cores_or_gib, round(avg(Value) / if(MetricName = 'k8s.node.allocatable_memory', pow(1024, 3), 1) * 2, 3) AS per_two_hours FROM clickland.otel_metrics_gauge WHERE MetricName IN ('k8s.node.allocatable_cpu', 'k8s.node.allocatable_memory') AND $W GROUP BY MetricName"
} > study/clickland-live/probe.md
echo "wrote study/clickland-live/probe.md"
