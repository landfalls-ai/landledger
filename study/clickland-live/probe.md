# Clickland live probe: the metrics a usage rollup can be built from

Read-only queries (`clickhouse-client --readonly 1`) against `clickland-infra-clickhouse-1` on OrbStack at 2026-11-14T17:07Z.
Written by `scripts/study-clickland-probe.sh`; nothing here was typed by hand.

## 1. Kubernetes and container metrics in the last day (gauges, then sums)

```sql
SELECT MetricName, any(MetricUnit) AS unit, count() AS points, uniqExact(ResourceAttributes['k8s.pod.name']) AS pods, min(TimeUnix) AS first_seen FROM clickland.otel_metrics_gauge WHERE (MetricName LIKE 'k8s.%' OR MetricName LIKE 'container.%') AND TimeUnix > now() - INTERVAL 1 DAY GROUP BY MetricName ORDER BY MetricName
```

```
    ┌─MetricName────────────────────────────┬─unit──────┬─points─┬─pods─┬──────────first_seen─┐
 1. │ container.cpu.usage                   │ {cpu}     │   5344 │   35 │ 2026-11-14 15:16:24 │
 2. │ container.cpu.utilization             │ 1         │  12056 │   36 │ 2026-11-14 15:15:05 │
 3. │ container.filesystem.available        │ By        │   5405 │   35 │ 2026-11-14 15:15:55 │
 4. │ container.filesystem.capacity         │ By        │   5405 │   35 │ 2026-11-14 15:15:55 │
 5. │ container.filesystem.usage            │ By        │   5405 │   35 │ 2026-11-14 15:15:55 │
 6. │ container.memory.percent              │ 1         │  12056 │   36 │ 2026-11-14 15:15:05 │
 7. │ container.memory.working_set          │ By        │   5407 │   35 │ 2026-11-14 15:15:55 │
 8. │ container.uptime                      │ s         │  12056 │   36 │ 2026-11-14 15:15:05 │
 9. │ k8s.container.cpu_limit               │ {cpu}     │     83 │    1 │ 2026-11-14 16:26:21 │
10. │ k8s.container.cpu_limit_utilization   │ 1         │     82 │    1 │ 2026-11-14 16:26:56 │
11. │ k8s.container.cpu_request             │ {cpu}     │   5474 │   34 │ 2026-11-14 15:16:23 │
12. │ k8s.container.memory_limit            │ By        │   5474 │   34 │ 2026-11-14 15:16:23 │
13. │ k8s.container.memory_request          │ By        │   5474 │   34 │ 2026-11-14 15:16:23 │
14. │ k8s.container.ready                   │           │   5735 │   36 │ 2026-11-14 15:16:23 │
15. │ k8s.container.restarts                │ {restart} │   5735 │   36 │ 2026-11-14 15:16:23 │
16. │ k8s.daemonset.current_scheduled_nodes │ {node}    │    177 │    1 │ 2026-11-14 15:46:21 │
17. │ k8s.daemonset.desired_scheduled_nodes │ {node}    │    177 │    1 │ 2026-11-14 15:46:21 │
18. │ k8s.daemonset.misscheduled_nodes      │ {node}    │    177 │    1 │ 2026-11-14 15:46:21 │
19. │ k8s.daemonset.ready_nodes             │ {node}    │    177 │    1 │ 2026-11-14 15:46:21 │
20. │ k8s.deployment.available              │ {pod}     │   5287 │    1 │ 2026-11-14 15:16:23 │
21. │ k8s.deployment.desired                │ {pod}     │   5287 │    1 │ 2026-11-14 15:16:23 │
22. │ k8s.namespace.phase                   │           │   1560 │    1 │ 2026-11-14 15:16:23 │
23. │ k8s.node.allocatable_cpu              │ {cpu}     │    260 │    1 │ 2026-11-14 15:16:23 │
24. │ k8s.node.allocatable_memory           │ By        │    260 │    1 │ 2026-11-14 15:16:23 │
25. │ k8s.node.condition_disk_pressure      │           │    260 │    1 │ 2026-11-14 15:16:23 │
26. │ k8s.node.condition_memory_pressure    │           │    260 │    1 │ 2026-11-14 15:16:23 │
27. │ k8s.node.condition_ready              │           │    260 │    1 │ 2026-11-14 15:16:23 │
28. │ k8s.node.cpu.usage                    │ {cpu}     │    228 │    1 │ 2026-11-14 15:16:24 │
29. │ k8s.node.filesystem.available         │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
30. │ k8s.node.filesystem.capacity          │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
31. │ k8s.node.filesystem.usage             │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
32. │ k8s.node.memory.available             │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
33. │ k8s.node.memory.major_page_faults     │ 1         │    244 │    1 │ 2026-11-14 15:15:55 │
34. │ k8s.node.memory.page_faults           │ 1         │    244 │    1 │ 2026-11-14 15:15:55 │
35. │ k8s.node.memory.rss                   │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
36. │ k8s.node.memory.usage                 │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
37. │ k8s.node.memory.working_set           │ By        │    244 │    1 │ 2026-11-14 15:15:55 │
38. │ k8s.pod.cpu.usage                     │ {cpu}     │   4256 │   35 │ 2026-11-14 15:16:24 │
39. │ k8s.pod.cpu_limit_utilization         │ 1         │     75 │    1 │ 2026-11-14 16:27:38 │
40. │ k8s.pod.filesystem.available          │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
41. │ k8s.pod.filesystem.capacity           │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
42. │ k8s.pod.filesystem.usage              │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
43. │ k8s.pod.memory.available              │ By        │   4924 │   34 │ 2026-11-14 15:15:55 │
44. │ k8s.pod.memory.major_page_faults      │ 1         │   5168 │   35 │ 2026-11-14 15:15:55 │
45. │ k8s.pod.memory.page_faults            │ 1         │   5168 │   35 │ 2026-11-14 15:15:55 │
46. │ k8s.pod.memory.rss                    │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
47. │ k8s.pod.memory.usage                  │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
48. │ k8s.pod.memory.working_set            │ By        │   5168 │   35 │ 2026-11-14 15:15:55 │
49. │ k8s.pod.memory_limit_utilization      │ 1         │   4924 │   34 │ 2026-11-14 15:15:55 │
50. │ k8s.pod.phase                         │           │   5475 │   36 │ 2026-11-14 15:16:23 │
51. │ k8s.replicaset.available              │ {pod}     │  27396 │    1 │ 2026-11-14 15:16:23 │
52. │ k8s.replicaset.desired                │ {pod}     │  27396 │    1 │ 2026-11-14 15:16:23 │
    └─MetricName────────────────────────────┴─unit──────┴─points─┴─pods─┴──────────first_seen─┘
```

```sql
SELECT MetricName, any(MetricUnit) AS unit, any(AggregationTemporality) AS temporality, any(IsMonotonic) AS monotonic, count() AS points FROM clickland.otel_metrics_sum WHERE (MetricName LIKE 'k8s.%' OR MetricName LIKE 'container.%') AND TimeUnix > now() - INTERVAL 1 DAY GROUP BY MetricName ORDER BY MetricName
```

```
    ┌─MetricName───────────────────────────────────┬─unit───────┬─temporality─┬─monotonic─┬─points─┐
 1. │ container.blockio.io_service_bytes_recursive │ By         │           2 │ true      │  47478 │
 2. │ container.cpu.time                           │ s          │           2 │ true      │   5328 │
 3. │ container.cpu.usage.kernelmode               │ ns         │           2 │ true      │  11960 │
 4. │ container.cpu.usage.total                    │ ns         │           2 │ true      │  11960 │
 5. │ container.cpu.usage.usermode                 │ ns         │           2 │ true      │  11960 │
 6. │ container.memory.file                        │ By         │           2 │ false     │  11945 │
 7. │ container.memory.usage.limit                 │ By         │           2 │ false     │  11960 │
 8. │ container.memory.usage.total                 │ By         │           2 │ false     │  11960 │
 9. │ container.network.io.usage.rx_bytes          │ By         │           2 │ true      │   6598 │
10. │ container.network.io.usage.rx_dropped        │ {packets}  │           2 │ true      │   6598 │
11. │ container.network.io.usage.tx_bytes          │ By         │           2 │ true      │   6598 │
12. │ container.network.io.usage.tx_dropped        │ {packets}  │           2 │ true      │   6598 │
13. │ container.restarts                           │ {restarts} │           2 │ true      │  11960 │
14. │ k8s.node.cpu.time                            │ s          │           2 │ true      │    240 │
15. │ k8s.node.network.errors                      │ 1          │           2 │ true      │    480 │
16. │ k8s.node.network.io                          │ By         │           2 │ true      │    480 │
17. │ k8s.pod.cpu.time                             │ s          │           2 │ true      │   5093 │
    └──────────────────────────────────────────────┴────────────┴─────────────┴───────────┴────────┘
```

## 2. Pod network and volume metrics, all time (empty: none stored)

```sql
SELECT MetricName, count() AS points FROM clickland.otel_metrics_sum WHERE MetricName IN ('k8s.pod.network.io', 'k8s.pod.network.errors') OR MetricName LIKE 'k8s.volume.%' GROUP BY MetricName
```

```
```

```sql
SELECT MetricName, count() AS points FROM clickland.otel_metrics_gauge WHERE MetricName LIKE 'k8s.volume.%' OR MetricName LIKE 'k8s.persistentvolume%' GROUP BY MetricName
```

```
```

## 3. Sampling interval (seconds between points of one series, last two hours)

```sql
SELECT MetricName, round(avg(gap), 1) AS avg_gap_s, min(gap) AS min_gap_s, max(gap) AS max_gap_s FROM (SELECT MetricName, ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, dateDiff('second', lagInFrame(TimeUnix) OVER (PARTITION BY MetricName, pod, c ORDER BY TimeUnix ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), TimeUnix) AS gap FROM clickland.otel_metrics_gauge WHERE MetricName IN ('k8s.container.cpu_request', 'container.cpu.usage', 'k8s.container.memory_request', 'container.memory.working_set', 'k8s.node.allocatable_cpu') AND TimeUnix > now() - INTERVAL 2 HOUR) WHERE gap > 0 AND gap < 3600 GROUP BY MetricName ORDER BY MetricName
```

```
   ┌─MetricName───────────────────┬─avg_gap_s─┬─min_gap_s─┬─max_gap_s─┐
1. │ container.cpu.usage          │      31.4 │         1 │       357 │
2. │ container.memory.working_set │      31.2 │         1 │       235 │
3. │ k8s.container.cpu_request    │      30.1 │        27 │        58 │
4. │ k8s.container.memory_request │      30.1 │        27 │        58 │
5. │ k8s.node.allocatable_cpu     │      30.1 │        27 │        58 │
   └──────────────────────────────┴───────────┴───────────┴───────────┘
```

## 4. The attributes a rollup would group by (one container's request series)

```sql
SELECT ResourceAttributes FROM clickland.otel_metrics_gauge WHERE MetricName = 'k8s.container.cpu_request' AND TimeUnix > now() - INTERVAL 1 HOUR LIMIT 1
```

```
   ┌─ResourceAttributes─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
1. │ {'container.id':'fe6ec303e83bf374c6d913ce22395bb2ec98ebe7a2a73cf8c311b1aa04597637','container.image.name':'ghcr.io/github/github-mcp-server','container.image.tag':'v2.0.2','k8s.cluster.name':'orbstack','k8s.container.name':'github-mcp-server','k8s.namespace.name':'landflow-dev','k8s.node.name':'orbstack','k8s.pod.name':'landflow-github-mcp-66d744cb9-8sqzp','k8s.pod.uid':'6deb9a15-86b0-45dc-a08b-0576992e5df9','service.name':'kubernetes'} │
   └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Two full hours as a rollup would see them: core-hours requested, used and max(request, usage)

Request (k8s_cluster) and usage (kubelet_stats) come from two receivers on their own clocks, so samples are
averaged per container and minute, then joined; a minute is 1/60 of an hour. Minutes with no request sample
(a container without a request, or a gap) are missing from the left side.

```sql
WITH req AS (SELECT ResourceAttributes['k8s.namespace.name'] AS ns, ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, toStartOfMinute(TimeUnix) AS m, avg(Value) AS v FROM clickland.otel_metrics_gauge WHERE MetricName = 'k8s.container.cpu_request' AND TimeUnix >= toStartOfHour(now()) - INTERVAL 2 HOUR AND TimeUnix < toStartOfHour(now()) GROUP BY ns, pod, c, m), use AS (SELECT ResourceAttributes['k8s.pod.uid'] AS pod, ResourceAttributes['k8s.container.name'] AS c, toStartOfMinute(TimeUnix) AS m, avg(Value) AS v FROM clickland.otel_metrics_gauge WHERE MetricName = 'container.cpu.usage' AND TimeUnix >= toStartOfHour(now()) - INTERVAL 2 HOUR AND TimeUnix < toStartOfHour(now()) GROUP BY pod, c, m) SELECT req.ns AS namespace, round(sum(req.v) / 60, 4) AS requested_core_h, round(sum(use.v) / 60, 4) AS used_core_h, round(greatest(sum(req.v), sum(use.v)) / 60, 4) AS max_of_sums_core_h, round(sum(greatest(req.v, use.v)) / 60, 4) AS sum_of_max_core_h FROM req LEFT JOIN use ON req.pod = use.pod AND req.c = use.c AND req.m = use.m GROUP BY namespace ORDER BY sum_of_max_core_h DESC LIMIT 15
```

```
   ┌─namespace─────┬─requested_core_h─┬─used_core_h─┬─max_of_sums_core_h─┬─sum_of_max_core_h─┐
1. │ landflow-dev  │            1.068 │      0.9472 │              1.068 │            1.4923 │
2. │ clickland-dev │            0.088 │      0.1344 │             0.1344 │            0.1814 │
3. │ kube-system   │           0.1733 │      0.0288 │             0.1733 │            0.1738 │
   └───────────────┴──────────────────┴─────────────┴────────────────────┴───────────────────┘
```

```sql
SELECT MetricName, round(avg(Value) / if(MetricName = 'k8s.node.allocatable_memory', pow(1024, 3), 1), 3) AS allocatable_cores_or_gib, round(avg(Value) / if(MetricName = 'k8s.node.allocatable_memory', pow(1024, 3), 1) * 2, 3) AS per_two_hours FROM clickland.otel_metrics_gauge WHERE MetricName IN ('k8s.node.allocatable_cpu', 'k8s.node.allocatable_memory') AND TimeUnix >= toStartOfHour(now()) - INTERVAL 2 HOUR AND TimeUnix < toStartOfHour(now()) GROUP BY MetricName
```

```
   ┌─MetricName──────────────────┬─allocatable_cores_or_gib─┬─per_two_hours─┐
1. │ k8s.node.allocatable_cpu    │                       18 │            36 │
2. │ k8s.node.allocatable_memory │                   15.662 │        31.323 │
   └─────────────────────────────┴──────────────────────────┴───────────────┘
```
