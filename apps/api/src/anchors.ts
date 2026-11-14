/**
 * Audit anchors (review of wave 1, finding 6): the audit chain's head is sent outside the database on a schedule, so a
 * log cut off at the end can't pass as whole. Each anchor goes to Clickland (an OpenTelemetry log record and a span
 * with the seq and hash as attributes, through the API's OTLP exporters) and to every webhook that takes `audit.anchor`,
 * and is recorded in `audit_anchors`, which `GET /api/audit/verify` compares the chain with.
 */
import { trace } from '@opentelemetry/api';
import type { Sql } from './db.js';
import type { IngestLog } from './ingest/runner.js';
import type { Webhooks } from './webhooks.js';

const tracer = trace.getTracer('landledger-audit');

export interface Anchor {
  seq: number;
  hash: string;
  at: string;
  deliveries: number;
}

/** Anchors the current head, unless it is already the last anchor; returns what was sent, or null. */
export async function anchorAudit(sql: Sql, webhooks: Webhooks, log: IngestLog): Promise<Anchor | null> {
  return tracer.startActiveSpan('audit anchor', async (span) => {
    try {
      const anchored = (await sql.begin(async (tx) => {
        // The same lock as appends: the head can't move while it is read and recorded.
        await tx`SELECT pg_advisory_xact_lock(hashtext('landledger:audit'))`;
        const [head] = await tx<
          { seq: string; hash: string }[]
        >`SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`;
        if (!head) return null;
        const [last] = await tx<{ seq: string }[]>`SELECT seq FROM audit_anchors ORDER BY seq DESC, id DESC LIMIT 1`;
        if (last && Number(last.seq) >= Number(head.seq)) return null;
        const at = new Date().toISOString();
        const { deliveries } = await webhooks.enqueue(tx, 'audit.anchor', {
          seq: Number(head.seq),
          hash: head.hash,
          at,
        });
        await tx`
          INSERT INTO audit_anchors (seq, hash, anchored_at, sinks)
          VALUES (${head.seq}, ${head.hash}, ${at}, ${tx.json({ log: 'otlp', webhook: deliveries })})`;
        return { seq: Number(head.seq), hash: head.hash, at, deliveries };
      })) as Anchor | null;
      if (anchored) {
        span.setAttributes({ 'landledger.audit.seq': anchored.seq, 'landledger.audit.hash': anchored.hash });
        log.info(
          { 'audit.seq': anchored.seq, 'audit.hash': anchored.hash, 'audit.webhooks': anchored.deliveries },
          `audit anchor: entry ${anchored.seq} ${anchored.hash}`,
        );
      }
      return anchored;
    } finally {
      span.end();
    }
  });
}
