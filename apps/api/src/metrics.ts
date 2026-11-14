/**
 * Cost metrics to Clickland (wave 1): what each service costs per day, next to its own telemetry. OTLP metrics over
 * HTTP (JSON) to the collector: `landledger.cost.estimated` and `landledger.cost.invoiced`, gauges in USD, one resource
 * per costed service (`service.name`, `k8s.namespace.name`), points labelled by agent, cost center and day. Today's and
 * yesterday's running totals are sent every few minutes, each point stamped with the time it was sent; the newest
 * point per day is the figure. Never rates, budgets or contracts: only what was spent.
 */
import type { Money } from '@landledger/money';
import { amount, type Line, type Spend } from './spend.js';

const DAY_MS = 86_400_000;

export interface MetricsLog {
  info(data: object, msg: string): void;
  warn(data: object, msg: string): void;
}

type Point = {
  service: string;
  namespace: string;
  agent: string;
  costCenter: string;
  day: string;
  basis: string;
  amount: Money;
};

/** The OTLP JSON body for `lines`, grouped per service (resource) and per agent, cost center and day (points). */
export function otlpCostMetrics(lines: readonly Line[], now = new Date()) {
  const points = new Map<string, Point>();
  for (const l of lines) {
    const t = l.tags;
    const s = (k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');
    const service = s('service') || l.serviceName;
    const namespace = s('namespace');
    const agent = s('agentName') || s('agent');
    const key = [service, namespace, agent, l.costCenter, l.day, l.basis].join('\u0000');
    const p = points.get(key);
    if (p) p.amount = p.amount.plus(l.amount);
    else
      points.set(key, {
        service,
        namespace,
        agent,
        costCenter: l.costCenter,
        day: l.day,
        basis: l.basis,
        amount: l.amount,
      });
  }
  const resources = new Map<string, Point[]>();
  for (const p of points.values()) {
    const k = `${p.service}\u0000${p.namespace}`;
    resources.set(k, [...(resources.get(k) ?? []), p]);
  }
  const nano = `${BigInt(now.getTime()) * 1_000_000n}`;
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return {
    resourceMetrics: [...resources.values()].map((ps) => ({
      resource: {
        attributes: [
          attr('service.name', ps[0]!.service),
          ...(ps[0]!.namespace && !ps[0]!.namespace.startsWith('compose:')
            ? [attr('k8s.namespace.name', ps[0]!.namespace)]
            : []),
          ...(ps[0]!.namespace.startsWith('compose:')
            ? [attr('docker.compose.project', ps[0]!.namespace.slice(8))]
            : []),
          attr('landledger.emitter', 'landledger-api'),
        ],
      },
      scopeMetrics: [
        {
          scope: { name: 'landledger.cost', version: '1' },
          metrics: (['estimated', 'invoiced'] as const)
            .map((basis) => ({
              name: `landledger.cost.${basis}`,
              unit: 'USD',
              description: `Cost per day, ${basis} (Landledger)`,
              gauge: {
                dataPoints: ps
                  .filter((p) => p.basis === basis)
                  .map((p) => ({
                    timeUnixNano: nano,
                    asDouble: Number(amount(p.amount)),
                    attributes: [
                      attr('landledger.day', p.day),
                      attr('landledger.cost_center', p.costCenter),
                      ...(p.agent ? [attr('agent', p.agent)] : []),
                    ],
                  })),
              },
            }))
            .filter((m) => m.gauge.dataPoints.length),
        },
      ],
    })),
  };
}

/** Sends today's and yesterday's cost per service to the collector; returns the number of points. */
export async function emitCostMetrics(
  spend: Spend,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
  const { lines } = await spend.lines(yesterday, today);
  if (!lines.length) return 0;
  const body = otlpCostMetrics(lines, now);
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The collector answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return body.resourceMetrics.reduce(
    (n, r) => n + r.scopeMetrics[0]!.metrics.reduce((m, x) => m + x.gauge.dataPoints.length, 0),
    0,
  );
}
