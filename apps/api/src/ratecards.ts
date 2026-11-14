/**
 * Rate card approval and the AI lines (spec 002): a version is proposed (by the seed or a person, a user either way) and
 * approved by a signed-in controller or CFO who neither proposed it nor added any of its lines; never by an API key, a
 * system actor or an agent (docs/plan.md principle 1; the database holds the same rules, migration 0005). Approval is
 * audited with a hash of the lines approved, and effective-dated: it closes the version before it on the new one's first
 * day.
 */
import type { LandflowPriceTable } from '@landledger/contracts';
import { Decimal, Rate } from '@landledger/money';
import type { PriceLine, PricedVersion } from '@landledger/pricing';
import { RateBook } from '@landledger/pricing';
import type { AuditLog } from './audit.js';
import { canonicalJson } from './canonical.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';

/** Who approves a version: a person (users.id), as the audit log names them. */
export interface VersionApprover {
  id: string;
  label: string;
  roles: readonly string[];
  actor: string;
  actorKind: 'person';
  requestId?: string;
}

type VersionRow = {
  id: string;
  rate_card_id: string;
  version: number;
  effective_from: Date;
  effective_to: Date | null;
  hours_per_month: string;
  proposed_by: string;
  approved_by: string | null;
  approved_at: Date | null;
};

type LineRow = {
  id: string;
  version_id: string;
  sku_id: string;
  sku_price_id: string;
  sku_meter: string;
  label: string;
  provider: string | null;
  model: string | null;
  pricing_unit: string;
  unit_price: string;
  currency: string;
  details: Record<string, unknown> | null;
  added_by: string;
  position: number;
};

/** What an approval approves, hashed into its audit entry: every line's identity, price and author, in order. */
export function linesHash(lines: readonly LineRow[]): string {
  return sha256(
    canonicalJson(
      [...lines]
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((l) => ({
          id: l.id,
          skuPriceId: l.sku_price_id,
          pricingUnit: l.pricing_unit,
          unitPrice: Decimal.parse(l.unit_price).toString(),
          currency: l.currency.trim(),
          details: l.details,
          addedBy: l.added_by,
        })),
    ),
  );
}

export const lineOf = (l: LineRow): PriceLine => ({
  id: l.id,
  skuId: l.sku_id,
  skuPriceId: l.sku_price_id,
  skuMeter: l.sku_meter,
  label: l.label,
  provider: l.provider,
  model: l.model,
  pricingUnit: l.pricing_unit,
  unitPrice: Decimal.parse(l.unit_price),
  currency: l.currency.trim(),
  details: l.details,
});

const METERS = [
  { key: 'input', meter: 'Input Tokens' },
  { key: 'cacheRead', meter: 'Cache Read Tokens' },
  { key: 'cacheWrite', meter: 'Cache Write Tokens' },
  { key: 'output', meter: 'Output Tokens' },
] as const;

/** AI rate lines for a price table entry: one per meter, and per meter of the long-context tier. */
export function aiLinesFor(p: LandflowPriceTable['defaults'][number]) {
  const provider = p.provider.toLowerCase();
  const sku = `${provider}:${p.model}`;
  const out: {
    sku: string;
    skuPriceId: string;
    meter: string;
    label: string;
    provider: string;
    model: string | null;
    price: string;
    details: Record<string, unknown>;
  }[] = [];
  const tier = (t: { input: string; output: string; cacheRead?: string; cacheWrite?: string }, long: string | null) => {
    for (const m of METERS) {
      const price = t[m.key];
      if (price === undefined) continue;
      out.push({
        sku,
        skuPriceId: `${sku}:${long ? 'long:' : ''}${m.key}`,
        meter: long ? `${m.meter} (over ${long})` : m.meter,
        label: `${p.model} ${m.meter.toLowerCase()}${long ? ` over ${long} tokens` : ''}`,
        provider,
        model: p.model === '*' ? null : p.model,
        price,
        details: long ? { Meter: m.key, Tier: 'long-context', Above: long } : { Meter: m.key },
      });
    }
  };
  tier(p, null);
  if (p.longContext) tier(p.longContext, p.longContext.above);
  return out;
}

/** Local models: priced at zero, provider-wide (this machine's hardware is in the cluster's figures). */
export const LOCAL_AI_ENTRIES: LandflowPriceTable['defaults'] = [
  { provider: 'ollama', model: '*', input: '0', output: '0' },
];

export class RateCards {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  /** Every approved version of a rate card with its lines, for pricing by day. */
  async book(rateCardId = 'rc_internal', tx: Tx = this.sql): Promise<RateBook> {
    const versions = await tx<VersionRow[]>`
      SELECT * FROM rate_card_versions WHERE rate_card_id = ${rateCardId} AND approved_at IS NOT NULL
      ORDER BY effective_from`;
    if (!versions.length) return new RateBook([]);
    const lines = await tx<LineRow[]>`
      SELECT * FROM rate_lines WHERE version_id IN ${tx(versions.map((v) => v.id))} ORDER BY position, id`;
    return new RateBook(
      versions.map((v): PricedVersion => ({
        id: v.id,
        version: v.version,
        effectiveFrom: day(v.effective_from),
        effectiveTo: v.effective_to ? day(v.effective_to) : null,
        hoursPerMonth: Decimal.parse(v.hours_per_month),
        lines: lines.filter((l) => l.version_id === v.id).map(lineOf),
      })),
    );
  }

  /** The newest version (approved or not), for the Overview's rate card line. */
  async latest(rateCardId = 'rc_internal') {
    const [v] = await this.sql<(VersionRow & { approver: string | null })[]>`
      SELECT v.*, u.email AS approver FROM rate_card_versions v LEFT JOIN users u ON u.id = v.approved_by
      WHERE v.rate_card_id = ${rateCardId} ORDER BY v.version DESC LIMIT 1`;
    return v ?? null;
  }

  /**
   * Adds AI lines from Landflow's price table to a **proposed** version (the database refuses lines on an approved
   * one), as the signed-in person who asked: they are the lines' author, so someone else approves. Lines it already
   * has are left alone; returns the number added.
   */
  async importAiLines(versionId: string, table: LandflowPriceTable, by: Principal): Promise<number> {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        "A person signed in with Landbright adds lines to a rate card, so the approver can be someone else; an API key or the local developer doesn't",
      );
    return this.sql.begin(async (tx) => {
      const [v] = await tx<VersionRow[]>`SELECT * FROM rate_card_versions WHERE id = ${versionId} FOR UPDATE`;
      if (!v) throw notFound('Rate card version');
      if (v.approved_at) throw new ApiError('conflict', `Version ${v.version} is approved: its lines never change`);
      // Review of wave 2: once the version's request exists its lines are frozen (the request's evidence hashes them).
      const [req] = await tx<{ id: string }[]>`
        SELECT id FROM requests WHERE change->>'type' = 'rate_card_version' AND change->>'versionId' = ${versionId}
        LIMIT 1`;
      if (req)
        throw new ApiError(
          'conflict',
          `Version ${v.version} is under request ${req.id}: its lines are frozen. Propose a new version to change them`,
          { requestId: req.id },
        );
      const [{ max }] =
        (await tx`SELECT coalesce(max(position), 0) AS max FROM rate_lines WHERE version_id = ${versionId}`) as unknown as [
          { max: number },
        ];
      let position = Number(max) + 1;
      const overridden = new Set(table.overrides.map((o) => `${o.provider.toLowerCase()}|${o.model}`));
      const entries = [
        ...table.overrides,
        ...table.defaults.filter((d) => !overridden.has(`${d.provider.toLowerCase()}|${d.model}`)),
        ...LOCAL_AI_ENTRIES,
      ];
      const added: string[] = [];
      for (const e of entries)
        for (const l of aiLinesFor(e)) {
          Rate.of(l.price, 'USD', '1000000 Tokens');
          const row = await tx`
            INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, provider, model, pricing_unit,
                                    unit_price, currency, details, position, added_by)
            VALUES (${`rl_${versionId.replace(/^rcv_/, '')}_${l.skuPriceId.replace(/[^\w.-]+/g, '_')}`}, ${versionId},
                    ${l.sku}, ${l.skuPriceId}, ${l.meter}, ${l.label}, ${l.provider}, ${l.model}, '1000000 Tokens',
                    ${l.price}::numeric, 'USD', ${tx.json(l.details as never)}, ${position++}, ${by.id})
            ON CONFLICT (version_id, sku_price_id) DO NOTHING RETURNING id`;
          if (row.length) added.push(l.skuPriceId);
        }
      if (added.length)
        await this.audit.append(
          {
            ...actorOf(by),
            action: 'rate_card.lines_imported',
            subjectType: 'rate_card_version',
            subjectId: versionId,
            data: { from: "Landflow's AI price table (USD per 1,000,000 tokens)", lines: added.length },
          },
          tx,
        );
      return added.length;
    }) as Promise<number>;
  }

  /**
   * Approves a proposed version: a person signed in with Landbright, a controller or the CFO, who isn't the proposer.
   * The version before it (if approved and open-ended) ends on this one's first day. Audited.
   */
  async approve(versionId: string, by: Principal) {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        'Only a person signed in with Landbright approves a rate card; an API key never does',
      );
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Approving a rate card is for the controller or the CFO');
    const label = by.email ?? by.id;
    return this.sql.begin((tx) =>
      this.approveIn(tx, versionId, { id: by.id, label, roles: by.roles, actor: label, actorKind: 'person' }),
    ) as Promise<Awaited<ReturnType<RateCards['approveIn']>>>;
  }

  /**
   * Approves a proposed version inside a transaction: the request path (the last step's person) and `approve` above.
   * The database checks again that the approver is a person who neither proposed it nor added a line (0005).
   */
  async approveIn(tx: Tx, versionId: string, by: VersionApprover) {
    const [v] = await tx<VersionRow[]>`SELECT * FROM rate_card_versions WHERE id = ${versionId} FOR UPDATE`;
    if (!v) throw notFound('Rate card version');
    if (v.approved_at) throw new ApiError('conflict', `Version ${v.version} is already approved`);
    if (v.proposed_by === by.id)
      throw new ApiError('forbidden', 'The person who proposed a rate card version cannot approve it');
    const lines = await tx<LineRow[]>`SELECT * FROM rate_lines WHERE version_id = ${versionId}`;
    if (!lines.length) throw new ApiError('bad_request', 'A version with no lines is not approved');
    if (lines.some((l) => l.added_by === by.id))
      throw new ApiError('forbidden', 'A person who added lines to a rate card version cannot approve it');
    const from = day(v.effective_from);
    const [locked] = await tx`
      SELECT month FROM periods WHERE status <> 'open' AND month >= date_trunc('month', ${from}::date) LIMIT 1`;
    if (locked) throw new ApiError('conflict', `A rate card can't take effect in a closing or locked month (${from})`);
    const ended = await tx<VersionRow[]>`
      UPDATE rate_card_versions SET effective_to = ${from}
      WHERE rate_card_id = ${v.rate_card_id} AND approved_at IS NOT NULL AND effective_to IS NULL
        AND effective_from < ${from}
      RETURNING *`;
    const [approved] = await tx<VersionRow[]>`
      UPDATE rate_card_versions SET approved_by = ${by.id}, approved_at = now() WHERE id = ${versionId} RETURNING *`;
    await this.audit.append(
      {
        actor: by.actor,
        actorKind: by.actorKind,
        action: 'rate_card.version_approved',
        subjectType: 'rate_card_version',
        subjectId: versionId,
        data: {
          version: v.version,
          effectiveFrom: from,
          proposedBy: v.proposed_by,
          approvedBy: by.label,
          roles: by.roles,
          ...(by.requestId ? { requestId: by.requestId } : {}),
          lines: lines.length,
          linesAddedBy: [...new Set(lines.map((l) => l.added_by))].sort(),
          linesSha256: linesHash(lines),
          ended: ended.map((e) => ({ id: e.id, effectiveTo: from })),
        },
      },
      tx,
    );
    return {
      id: approved!.id,
      version: approved!.version,
      effectiveFrom: from,
      approvedBy: by.label,
      approvedAt: approved!.approved_at!.toISOString(),
    };
  }
}
