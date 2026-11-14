-- 0006_data_model: the data model gaps of wave 1's review (finding 10). Original-currency amounts with the rate they
-- were converted at; invoice lines linked to the estimates they replace; cost center codes that allocations and
-- budgets must name; budgets refused for locked months. Shipped migrations are never edited: a change is a new file.

-- A charge in another currency: the source's amount, its currency and the fx_rates row it was converted at. The
-- ledger's amounts stay in billing_currency (USD); reads never add currencies (Money.sum refuses).
ALTER TABLE cost_records ADD COLUMN
  original_cost      numeric CHECK (original_cost IS NULL OR original_cost = round(original_cost, 6));
ALTER TABLE cost_records ADD COLUMN
  original_currency  char(3) CHECK (original_currency IS NULL OR original_currency ~ '^[A-Z]{3}$');
ALTER TABLE cost_records ADD COLUMN
  fx_rate_id         text REFERENCES fx_rates (id);
ALTER TABLE cost_records ADD CONSTRAINT cost_records_original_currency CHECK (
  ((original_cost IS NULL) = (original_currency IS NULL)) AND ((original_cost IS NULL) = (fx_rate_id IS NULL))
  AND (original_currency IS NULL OR original_currency <> billing_currency));
ALTER TABLE provisional_usage
  ADD COLUMN original_cost numeric,
  ADD COLUMN original_currency char(3),
  ADD COLUMN fx_rate_id text REFERENCES fx_rates (id),
  ADD CONSTRAINT provisional_original_currency CHECK (
    ((original_cost IS NULL) = (original_currency IS NULL)) AND ((original_cost IS NULL) = (fx_rate_id IS NULL)));

-- A reversal negates the original amount too, in the same currency and at the same rate.
CREATE OR REPLACE FUNCTION cost_records_enter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m date := (NEW.billing_period_start AT TIME ZONE 'UTC')::date;
  st text;
  orig cost_record_keys;
  amounts record;
BEGIN
  -- The month: created open by its first record; a locked month (or one before a locked month) takes nothing.
  INSERT INTO periods (month) VALUES (m) ON CONFLICT DO NOTHING;
  SELECT status INTO st FROM periods WHERE month = m FOR SHARE;
  IF st = 'locked' OR EXISTS (SELECT 1 FROM periods WHERE month > m AND status = 'locked') THEN
    RAISE EXCEPTION 'period % is locked: book a correction in the open month', to_char(m, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.correction_of_id IS NOT NULL THEN
    -- A reversal: of an entry (not a reversal) of the same key and basis, with every amount negated.
    SELECT * INTO orig FROM cost_record_keys WHERE record_id = NEW.correction_of_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record % reverses %, which is not in the ledger', NEW.record_id, NEW.correction_of_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF orig.is_reversal OR orig.source_key <> NEW.source_key OR orig.basis <> NEW.basis THEN
      RAISE EXCEPTION 'a reversal reverses an entry of its own source key and basis, never another reversal'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT billed_cost_micros, effective_cost_micros, list_cost_micros, contracted_cost_micros, billing_currency,
           original_cost, original_currency, fx_rate_id
      INTO amounts FROM cost_records
      WHERE record_id = NEW.correction_of_id AND billing_period_start = orig.billing_period_start;
    IF amounts.billed_cost_micros <> -NEW.billed_cost_micros OR amounts.effective_cost_micros <> -NEW.effective_cost_micros
       OR amounts.list_cost_micros <> -NEW.list_cost_micros OR amounts.contracted_cost_micros <> -NEW.contracted_cost_micros
       OR amounts.billing_currency <> NEW.billing_currency
       OR amounts.original_cost IS DISTINCT FROM -NEW.original_cost
       OR amounts.original_currency IS DISTINCT FROM NEW.original_currency
       OR amounts.fx_rate_id IS DISTINCT FROM NEW.fx_rate_id THEN
      RAISE EXCEPTION 'a reversal negates every amount of the record it reverses' USING ERRCODE = 'check_violation';
    END IF;
    NEW.source_revision := orig.source_revision;
  ELSE
    -- An entry: only when the key has no live entry for this basis (reverse that first).
    PERFORM pg_advisory_xact_lock(hashtextextended('landledger:cost_records:' || NEW.basis || ':' || NEW.source_key, 0));
    IF EXISTS (SELECT 1 FROM cost_record_keys k
               WHERE k.source_key = NEW.source_key AND k.basis = NEW.basis AND NOT k.is_reversal
                 AND NOT EXISTS (SELECT 1 FROM cost_record_keys r WHERE r.correction_of_id = k.record_id)) THEN
      RAISE EXCEPTION '% (%) has a live entry: reverse it before a re-entry', NEW.source_key, NEW.basis
        USING ERRCODE = 'unique_violation';
    END IF;
    SELECT coalesce(max(source_revision) + 1, 0) INTO NEW.source_revision
      FROM cost_record_keys WHERE source_key = NEW.source_key AND basis = NEW.basis;
  END IF;

  INSERT INTO cost_record_keys (record_id, source_key, basis, source_revision, is_reversal, correction_of_id,
                                billing_period_start)
  VALUES (NEW.record_id, NEW.source_key, NEW.basis, NEW.source_revision, NEW.correction_of_id IS NOT NULL,
          NEW.correction_of_id, NEW.billing_period_start);
  RETURN NEW;
END $$;

-- The FOCUS view gains the three columns, at its end.
CREATE OR REPLACE VIEW cost_records_focus AS
SELECT
  (billed_cost_micros::numeric / 1000000)::numeric(38,6)      AS "BilledCost",
  (effective_cost_micros::numeric / 1000000)::numeric(38,6)   AS "EffectiveCost",
  (list_cost_micros::numeric / 1000000)::numeric(38,6)        AS "ListCost",
  (contracted_cost_micros::numeric / 1000000)::numeric(38,6)  AS "ContractedCost",
  list_unit_price                                             AS "ListUnitPrice",
  contracted_unit_price                                       AS "ContractedUnitPrice",
  pricing_quantity                                            AS "PricingQuantity",
  pricing_unit                                                AS "PricingUnit",
  consumed_quantity                                           AS "ConsumedQuantity",
  consumed_unit                                               AS "ConsumedUnit",
  billing_currency::text                                      AS "BillingCurrency",
  to_char(charge_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')  AS "ChargePeriodStart",
  to_char(charge_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')    AS "ChargePeriodEnd",
  to_char(billing_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "BillingPeriodStart",
  to_char(billing_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')   AS "BillingPeriodEnd",
  charge_category          AS "ChargeCategory",
  charge_class             AS "ChargeClass",
  charge_description       AS "ChargeDescription",
  charge_frequency         AS "ChargeFrequency",
  pricing_category         AS "PricingCategory",
  service_category         AS "ServiceCategory",
  service_subcategory      AS "ServiceSubcategory",
  service_name             AS "ServiceName",
  service_provider_name    AS "ServiceProviderName",
  host_provider_name       AS "HostProviderName",
  invoice_issuer_name      AS "InvoiceIssuerName",
  billing_account_id       AS "BillingAccountId",
  billing_account_name     AS "BillingAccountName",
  sub_account_id           AS "SubAccountId",
  sub_account_name         AS "SubAccountName",
  sub_account_type         AS "SubAccountType",
  invoice_id               AS "InvoiceId",
  resource_id              AS "ResourceId",
  resource_name            AS "ResourceName",
  resource_type            AS "ResourceType",
  sku_id                   AS "SkuId",
  sku_meter                AS "SkuMeter",
  sku_price_id             AS "SkuPriceId",
  sku_price_details        AS "SkuPriceDetails",
  tags                     AS "Tags",
  allocated_method_id      AS "AllocatedMethodId",
  allocated_method_details AS "AllocatedMethodDetails",
  allocated_resource_id    AS "AllocatedResourceId",
  allocated_resource_name  AS "AllocatedResourceName",
  allocated_tags           AS "AllocatedTags",
  record_id                AS "x_RecordId",
  basis                    AS "x_Basis",
  source                   AS "x_Source",
  source_key               AS "x_SourceKey",
  source_cost              AS "x_SourceCost",
  rate_card_version_id     AS "x_RateCardVersion",
  ingest_run_id            AS "x_IngestRunId",
  correction_of_id         AS "x_CorrectionOfId",
  workflow_id              AS "x_WorkflowId",
  agent_id                 AS "x_AgentId",
  actor_id                 AS "x_ActorId",
  original_cost            AS "x_OriginalCost",
  original_currency::text  AS "x_OriginalCurrency",
  fx_rate_id               AS "x_FxRateId"
FROM cost_records;

-- An invoice line replaces the estimates of the charges it bills. Linked by the estimate's source key (so a corrected
-- estimate stays linked), within one billing month. Reads never add an estimate to the invoice that replaces it: an
-- estimated record whose source key is linked to a live invoiced record is left out of every figure (apps/api
-- spend.ts). Append only.
CREATE TABLE invoice_estimate_links (
  estimated_source_key  text PRIMARY KEY,
  invoiced_record_id    text NOT NULL,
  month                 date NOT NULL CHECK (landledger_first_of_month(month)),
  linked_by             text NOT NULL REFERENCES users (id),
  linked_at             timestamptz NOT NULL DEFAULT now(),
  note                  text NOT NULL DEFAULT ''
);
CREATE INDEX invoice_estimate_links_invoice ON invoice_estimate_links (invoiced_record_id);

CREATE FUNCTION invoice_estimate_links_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv cost_record_keys;
BEGIN
  SELECT * INTO inv FROM cost_record_keys WHERE record_id = NEW.invoiced_record_id;
  IF NOT FOUND OR inv.basis <> 'invoiced' OR inv.is_reversal THEN
    RAISE EXCEPTION 'record % is not an invoiced entry in the ledger', NEW.invoiced_record_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (inv.billing_period_start AT TIME ZONE 'UTC')::date <> NEW.month THEN
    RAISE EXCEPTION 'an invoice line replaces estimates of its own billing month' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cost_record_keys k WHERE k.source_key = NEW.estimated_source_key
                   AND k.basis = 'estimated' AND (k.billing_period_start AT TIME ZONE 'UTC')::date = NEW.month) THEN
    RAISE EXCEPTION 'no estimate % in %', NEW.estimated_source_key, to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM periods WHERE month = NEW.month AND status = 'locked') THEN
    RAISE EXCEPTION 'period % is locked: its figures never move', to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_estimate_links_check BEFORE INSERT ON invoice_estimate_links
  FOR EACH ROW EXECUTE FUNCTION invoice_estimate_links_check();
CREATE TRIGGER invoice_estimate_links_append_only BEFORE UPDATE OR DELETE ON invoice_estimate_links
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER invoice_estimate_links_no_truncate BEFORE TRUNCATE ON invoice_estimate_links
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Cost center codes: every code a version of cost_centers has, and the two targets that aren't cost centers
-- (SHARED-POOL, UNALLOCATED). Allocations and budgets name a code from here.
CREATE TABLE cost_center_codes (
  code        text PRIMARY KEY,
  kind        text NOT NULL DEFAULT 'cost_center' CHECK (kind IN ('cost_center','pool')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cost_center_codes (code, kind) VALUES ('SHARED-POOL', 'pool'), ('UNALLOCATED', 'pool');
INSERT INTO cost_center_codes (code) SELECT DISTINCT code FROM cost_centers ON CONFLICT DO NOTHING;
CREATE TRIGGER cost_center_codes_append_only BEFORE UPDATE OR DELETE ON cost_center_codes
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER cost_center_codes_no_truncate BEFORE TRUNCATE ON cost_center_codes
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE FUNCTION cost_centers_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cost_center_codes (code) VALUES (NEW.code) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_centers_code BEFORE INSERT ON cost_centers
  FOR EACH ROW EXECUTE FUNCTION cost_centers_code();

ALTER TABLE allocations
  ADD CONSTRAINT allocations_cost_center_fkey FOREIGN KEY (cost_center) REFERENCES cost_center_codes (code);
ALTER TABLE budgets
  ADD CONSTRAINT budgets_cost_center_code_fkey FOREIGN KEY (cost_center_code) REFERENCES cost_center_codes (code);

-- A locked month's budgets never change: an import that names one is refused.
CREATE FUNCTION budgets_open_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM periods WHERE month = NEW.month AND status = 'locked') THEN
    RAISE EXCEPTION 'period % is locked: its budget is final', to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budgets_open_month BEFORE INSERT ON budgets
  FOR EACH ROW EXECUTE FUNCTION budgets_open_month();
