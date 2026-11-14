import type { CostCenter, Origin, Product, RateCard, RateCardVersion, Team } from '@landledger/contracts';
import { day, type Sql } from './db.js';
import { notFound } from './errors.js';

type Dim = {
  code: string;
  version: number;
  name: string;
  owner_name: string | null;
  owner_subject: string | null;
  valid_from: Date;
  valid_to: Date | null;
  origin: Origin;
};
const dim = (r: Dim) => ({
  code: r.code,
  version: r.version,
  name: r.name,
  ownerName: r.owner_name,
  ownerSubject: r.owner_subject,
  validFrom: day(r.valid_from),
  validTo: r.valid_to ? day(r.valid_to) : null,
  origin: r.origin,
});

/** The dimensions and rate cards as they stand on a day (today unless asked). Read only for now. */
export class Dimensions {
  constructor(private readonly sql: Sql) {}

  async costCenters(on: string): Promise<CostCenter[]> {
    const rows = await this.sql<(Dim & { description: string })[]>`
      SELECT * FROM cost_centers
      WHERE valid_from <= ${on}::date AND (valid_to IS NULL OR valid_to > ${on}::date) ORDER BY code`;
    return rows.map((r) => ({ ...dim(r), description: r.description }));
  }

  async teams(on: string): Promise<Team[]> {
    const rows = await this.sql<(Dim & { cost_center_code: string | null })[]>`
      SELECT * FROM teams
      WHERE valid_from <= ${on}::date AND (valid_to IS NULL OR valid_to > ${on}::date) ORDER BY code`;
    return rows.map((r) => ({ ...dim(r), costCenterCode: r.cost_center_code }));
  }

  async products(on: string): Promise<Product[]> {
    const rows = await this.sql<Dim[]>`
      SELECT * FROM products
      WHERE valid_from <= ${on}::date AND (valid_to IS NULL OR valid_to > ${on}::date) ORDER BY code`;
    return rows.map(dim);
  }

  async rateCards(on: string): Promise<RateCard[]> {
    const cards = await this.sql<{ id: string; name: string; currency: string; owner: string }[]>`
      SELECT id, name, currency, owner FROM rate_cards ORDER BY name`;
    return Promise.all(cards.map((c) => this.withVersions(c, on)));
  }

  async rateCard(id: string, on: string): Promise<RateCard> {
    const [card] = await this.sql<{ id: string; name: string; currency: string; owner: string }[]>`
      SELECT id, name, currency, owner FROM rate_cards WHERE id = ${id}`;
    if (!card) throw notFound('Rate card');
    return this.withVersions(card, on);
  }

  private async withVersions(
    card: { id: string; name: string; currency: string; owner: string },
    on: string,
  ): Promise<RateCard> {
    const versions = await this.sql<
      {
        id: string;
        version: number;
        effective_from: Date;
        effective_to: Date | null;
        hours_per_month: string;
        note: string;
        proposed_by: string;
        proposed_at: Date;
        approved_by: string | null;
        approved_at: Date | null;
      }[]
    >`SELECT * FROM rate_card_versions WHERE rate_card_id = ${card.id} ORDER BY version DESC`;
    const lines = versions.length
      ? await this.sql<
          {
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
          }[]
        >`
          SELECT * FROM rate_lines WHERE version_id IN ${this.sql(versions.map((v) => v.id))}
          ORDER BY position, sku_price_id`
      : [];
    const list: RateCardVersion[] = versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.approved_at ? 'approved' : 'proposed',
      effectiveFrom: day(v.effective_from),
      effectiveTo: v.effective_to ? day(v.effective_to) : null,
      hoursPerMonth: v.hours_per_month,
      note: v.note,
      proposedBy: v.proposed_by,
      proposedAt: v.proposed_at.toISOString(),
      approvedBy: v.approved_by,
      approvedAt: v.approved_at?.toISOString() ?? null,
      lines: lines
        .filter((l) => l.version_id === v.id)
        .map((l) => ({
          id: l.id,
          skuId: l.sku_id,
          skuPriceId: l.sku_price_id,
          skuMeter: l.sku_meter,
          label: l.label,
          provider: l.provider,
          model: l.model,
          pricingUnit: l.pricing_unit,
          unitPrice: l.unit_price,
          currency: l.currency,
          details: l.details,
        })),
    }));
    const current =
      list.find(
        (v) => v.status === 'approved' && v.effectiveFrom <= on && (v.effectiveTo === null || v.effectiveTo > on),
      ) ?? null;
    return { ...card, current, versions: list };
  }
}
