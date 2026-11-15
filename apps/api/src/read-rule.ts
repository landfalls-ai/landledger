/**
 * The read rule every figure shares (spec 005, review of wave 3): which rows a total leaves out. Kept apart so the
 * spend reads and the invoices that write the links use one definition.
 */
import type { Tx } from './db.js';

/** The tag a `dev-fixture` invoice's records carry: every figure but Reconciliation's leaves them out. */
export const DEV_FIXTURE = 'dev-fixture';

/**
 * On an estimated row `r`: left out by a `split` or `late` link while the invoiced entry the link names was live as of
 * r's own billing month: entered in or before it, and not reversed in or before it. A void while that month is open
 * gives the estimate back; once it locks, nothing later moves it (a void then books the estimates back in the open
 * month as restores). `prefix` narrows it to one invoice's links.
 */
export function hiddenSql(s: Tx, prefix: string | null = null) {
  return s`EXISTS (
    SELECT 1 FROM invoice_estimate_links l
    JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
    JOIN cost_record_keys y ON y.source_key = k.source_key AND y.basis = 'invoiced' AND NOT y.is_reversal
    WHERE l.estimated_source_key = r.source_key AND l.kind <> 'trued_up'
      ${prefix ? s`AND starts_with(k.source_key, ${prefix})` : s``}
      AND y.billing_period_start <= r.billing_period_start
      AND NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = y.record_id
                        AND x.billing_period_start <= r.billing_period_start))`;
}

/** Rows no total counts: a dev fixture's records, and (outside the anomaly scan) the `dev-anomaly` test spike. */
export function devExcluded(s: Tx, includeDev: boolean) {
  return includeDev
    ? s`coalesce(r.tags->>'origin', '') <> ${DEV_FIXTURE}`
    : s`coalesce(r.tags->>'origin', '') <> ${DEV_FIXTURE} AND r.source <> 'dev-anomaly'`;
}
