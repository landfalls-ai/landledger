/**
 * What Landledger reads from its sources (spec 002): Landflow's usage ledger, AI insights and price table, and
 * Clickland's resource usage rollup. Every JSON number is read from its text (`parseJsonExact`), never through a
 * float: a quantity or price is a decimal string here and a `Decimal` once parsed.
 */
import { z } from 'zod';

/**
 * JSON.parse that keeps every number as the exact text it was written with (`0.1` → `"0.1"`, `2286` → `"2286"`), using
 * the reviver's source text (ES2025 JSON.parse source text access). Strings stay strings.
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? String(value)) : value,
  );
}

/** A number as JSON wrote it, kept as text: an integer or a plain decimal (an exponent is refused). */
const Num = z.string().regex(/^-?\d+(\.\d+)?$/, 'a plain decimal number');
const Int = z.string().regex(/^\d+$/, 'a whole number');

// Landflow ------------------------------------------------------------------------------------------------------------

/** An `ai.call` usage event (`GET /api/usage/events?kinds=ai.call`). */
export const LandflowAiEvent = z.object({
  id: z.string().min(1),
  at: z.string(),
  day: z.string().optional(),
  kind: z.literal('ai.call'),
  projectId: z.string().nullish(),
  workflowId: z.string().nullish(),
  agentId: z.string().nullish(),
  actorId: z.string().nullish(),
  executionId: z.string().nullish(),
  tokens: Int.nullish(),
  /** Landflow's own estimate in USD, cache reads and writes at the cache prices. */
  cost: Num.nullish(),
  attrs: z
    .object({
      provider: z.string().default(''),
      model: z.string().default(''),
      operation: z.string().optional(),
      input: Int.default('0'),
      output: Int.default('0'),
      /** Parts of `input` (Landflow backbone wave 3). Absent on older events: unknown, not 0. */
      cacheRead: Int.optional(),
      cacheWrite: Int.optional(),
    })
    .loose(),
});
export type LandflowAiEvent = z.infer<typeof LandflowAiEvent>;

export const LandflowEvents = z.object({ events: z.array(z.unknown()) });

/** `GET /api/usage?groupBy=model&kinds=ai.call`: per model, calls (`count`) and tokens. */
export const LandflowUsageReport = z.object({
  rows: z.array(z.object({ key: z.string(), count: Int, tokens: Int.default('0'), cost: Num.nullish() }).loose()),
  totals: z.object({ count: Int, tokens: Int.default('0') }).loose(),
});
export type LandflowUsageReport = z.infer<typeof LandflowUsageReport>;

/** `GET /api/insights/ai-usage?from=&to=`: totals, per model and per day; cache tokens are parts of input. */
export const LandflowAiInsights = z.object({
  models: z.array(
    z
      .object({
        provider: z.string(),
        model: z.string(),
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int.optional(),
        cacheWriteTokens: Int.optional(),
        cost: Num.nullish(),
        calls: Int,
      })
      .loose(),
  ),
});
export type LandflowAiInsights = z.infer<typeof LandflowAiInsights>;

/** One entry of Landflow's price table (`GET /api/settings/ai-prices`), USD per million tokens. */
const PriceTier = z.object({ input: Num, output: Num, cacheRead: Num.optional(), cacheWrite: Num.optional() });
export const LandflowPrice = PriceTier.extend({
  provider: z.string(),
  model: z.string(),
  longContext: PriceTier.extend({ above: Int }).optional(),
});
export type LandflowPrice = z.infer<typeof LandflowPrice>;
export const LandflowPriceTable = z.object({ defaults: z.array(LandflowPrice), overrides: z.array(LandflowPrice) });
export type LandflowPriceTable = z.infer<typeof LandflowPriceTable>;

// Clickland -----------------------------------------------------------------------------------------------------------

const Q = z.string().regex(/^-?\d+(\.\d+)?$/, 'a six-decimal quantity');

export const ClicklandUsageRow = z.object({
  start: z.string(),
  end: z.string(),
  source: z.enum(['kubernetes', 'docker']),
  group: z.record(z.string(), z.string()),
  cpuCoreHours: Q,
  cpuRequestedCoreHours: Q.optional(),
  cpuAllocatedCoreHours: Q.optional(),
  memoryGiBHours: Q,
  memoryRequestedGiBHours: Q.optional(),
  memoryAllocatedGiBHours: Q.optional(),
  storageGiBHours: Q.nullish(),
  networkRxGB: Q.nullish(),
  networkTxGB: Q.nullish(),
  networkEgressGB: Q.nullish(),
  samples: Int.optional(),
});
export type ClicklandUsageRow = z.infer<typeof ClicklandUsageRow>;

export const ClicklandRollup = z.object({
  rows: z.array(ClicklandUsageRow),
  capacity: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        cluster: z.string(),
        node: z.string(),
        cpuAllocatableCoreHours: Q,
        memoryAllocatableGiBHours: Q,
      }),
    )
    .default([]),
  volumes: z
    .array(
      z.object({
        cluster: z.string(),
        namespace: z.string(),
        claim: z.string(),
        capacityGiBHours: Q,
        usedGiBHours: Q,
        sharesNodeFilesystem: z.boolean(),
      }),
    )
    .default([]),
  coverage: z
    .object({
      sources: z
        .array(
          z.object({
            source: z.string(),
            firstSample: z.string().nullable(),
            lastSample: z.string().nullable(),
            missingBuckets: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      missing: z.array(z.object({ field: z.string(), reason: z.string(), fix: z.string().optional() })).default([]),
    })
    .loose(),
});
export type ClicklandRollup = z.infer<typeof ClicklandRollup>;
