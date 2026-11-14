/**
 * The two sources wave 1 reads (spec 002): Landflow's usage ledger and Clickland's resource usage rollup. Each answer
 * is parsed from its text with `parseJsonExact`, so no quantity or price ever passes through a float.
 */
import {
  ClicklandRollup,
  LandflowAiEvent,
  LandflowAiInsights,
  LandflowEvents,
  LandflowPriceTable,
  LandflowUsageReport,
  parseJsonExact,
} from '@landledger/contracts';
import { z } from 'zod';

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}

async function getJson<S extends z.ZodType>(
  source: string,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  schema: S,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new SourceError(source, `${new URL(url).pathname} did not answer (${e instanceof Error ? e.message : e})`);
  }
  const text = await response.text();
  if (!response.ok)
    throw new SourceError(source, `${new URL(url).pathname} answered ${response.status}: ${text.slice(0, 300)}`);
  const parsed = schema.safeParse(parseJsonExact(text));
  if (!parsed.success)
    throw new SourceError(
      source,
      `${new URL(url).pathname} answered an unexpected shape: ${parsed.error.issues[0]?.message}`,
    );
  return parsed.data;
}

/** At most this many events per call (Landflow's `limit` maximum). */
export const EVENTS_LIMIT = 5000;

export interface LandflowNames {
  agents: Map<string, string>;
  workflows: Map<string, string>;
}

/** Landflow, read with an owner or admin `lf_` key (members see only what they can open). */
export class LandflowClient {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get<S extends z.ZodType>(path: string, schema: S) {
    return getJson(
      'Landflow',
      this.fetchImpl,
      `${this.baseUrl.replace(/\/$/, '')}${path}`,
      {
        headers: { authorization: `Bearer ${this.key}`, accept: 'application/json' },
      },
      schema,
    );
  }

  /**
   * Every `ai.call` event with `from ≤ at ≤ to` (Landflow's bounds are both inclusive), deduplicated by id. A window
   * that comes back full (5,000) is split in two and read again, down to one second.
   */
  async aiEvents(from: Date, to: Date, warnings: string[] = []): Promise<LandflowAiEvent[]> {
    const out = new Map<string, LandflowAiEvent>();
    const read = async (a: Date, b: Date): Promise<void> => {
      const q = new URLSearchParams({
        kinds: 'ai.call',
        from: a.toISOString(),
        to: b.toISOString(),
        limit: String(EVENTS_LIMIT),
      });
      const { events } = await this.get(`/api/usage/events?${q}`, LandflowEvents);
      if (events.length >= EVENTS_LIMIT && b.getTime() - a.getTime() > 1000) {
        const mid = new Date(a.getTime() + Math.floor((b.getTime() - a.getTime()) / 2));
        await read(a, mid);
        await read(new Date(mid.getTime() + 1), b);
        return;
      }
      if (events.length >= EVENTS_LIMIT)
        warnings.push(`Landflow: ${EVENTS_LIMIT} events in one second at ${a.toISOString()}; some may be missing`);
      for (const raw of events) {
        const e = LandflowAiEvent.safeParse(raw);
        if (!e.success) {
          warnings.push(`Landflow: an ai.call event couldn't be read (${e.error.issues[0]?.message})`);
          continue;
        }
        out.set(e.data.id, e.data);
      }
    };
    // One hour per call, `to` = the hour's end − 1 ms, so hours never overlap.
    for (let t = from.getTime(); t <= to.getTime(); t += 3_600_000) {
      const end = Math.min(t + 3_600_000 - 1, to.getTime());
      await read(new Date(t), new Date(end));
    }
    return [...out.values()];
  }

  /** Calls and tokens per model for the window: the check that the events read add up. */
  usageByModel(from: Date, to: Date) {
    const q = new URLSearchParams({
      groupBy: 'model',
      kinds: 'ai.call',
      from: from.toISOString(),
      to: to.toISOString(),
      limit: '1000',
    });
    return this.get(`/api/usage?${q}`, LandflowUsageReport);
  }

  /** Per model: input, output, cache read and cache write tokens and Landflow's cost (instance days). */
  insights(fromDay: string, toDay: string) {
    const q = new URLSearchParams({ from: fromDay, to: toDay });
    return this.get(`/api/insights/ai-usage?${q}`, LandflowAiInsights);
  }

  prices() {
    return this.get('/api/settings/ai-prices', LandflowPriceTable);
  }

  /** Agent and workflow names, so Explore and the rules can say "Triage lead" rather than `ag_…`. */
  async names(): Promise<LandflowNames> {
    const list = async (path: string, field: string) => {
      try {
        const body = await this.get(path, z.record(z.string(), z.unknown()));
        const arr = (body[field] ?? []) as { id?: unknown; name?: unknown }[];
        return new Map(
          arr.filter((x) => typeof x.id === 'string').map((x) => [x.id as string, String(x.name ?? x.id)]),
        );
      } catch {
        return new Map<string, string>();
      }
    };
    return { agents: await list('/api/agents', 'agents'), workflows: await list('/api/workflows', 'workflows') };
  }
}

export const CLICKLAND_GROUP_BY = [
  'k8s.cluster.name',
  'k8s.namespace.name',
  'k8s.workload.kind',
  'k8s.workload.name',
  'k8s.container.name',
  'compose.project',
  'compose.service',
  'container.name',
] as const;

/** Clickland, read with a key that has only `usage:read`. */
export class ClicklandClient {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Pod labels to group by too (`team`, …), for allocation rules that select on labels. */
    private readonly labels: readonly string[] = [],
  ) {}

  /** One UTC day's rollup, grouped as Landledger prices it. */
  rollup(from: Date, to: Date) {
    return getJson(
      'Clickland',
      this.fetchImpl,
      `${this.baseUrl.replace(/\/$/, '')}/api/usage/rollup`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          from: from.toISOString(),
          to: to.toISOString(),
          granularity: 'day',
          groupBy: [...CLICKLAND_GROUP_BY, ...this.labels.map((l) => `k8s.pod.label.${l}`)],
        }),
      },
      ClicklandRollup,
    );
  }
}
