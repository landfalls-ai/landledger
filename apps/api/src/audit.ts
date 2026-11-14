import type { ActorKind, AuditEntry, AuditVerify } from '@landledger/contracts';
import { canonicalJson } from './canonical.js';
import { inTransaction, type Sql, type Tx } from './db.js';
import { sha256 } from './ids.js';

/** The first entry's previous hash. */
export const GENESIS = '0'.repeat(64);

export interface AuditInput {
  actor: string;
  actorKind: ActorKind;
  /** `auth.signed_in`, `api_key.created`, `rate_card.version_created`, … */
  action: string;
  subjectType: string;
  subjectId: string;
  /** Plain JSON: strings, booleans, null, safe integers; money as minor-unit strings. */
  data?: Record<string, unknown>;
}

/** What is hashed: everything in the entry but the hashes themselves. */
export interface HashedEntry {
  seq: number;
  at: string;
  actor: string;
  actorKind: ActorKind;
  action: string;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
}

/** `sha256(prev_hash ‖ canonical_json(entry))`, hex. */
export function chainHash(prevHash: string, entry: HashedEntry): string {
  return sha256(prevHash + canonicalJson(entry));
}

type Row = {
  seq: string;
  at: Date;
  actor: string;
  actor_kind: ActorKind;
  action: string;
  subject_type: string;
  subject_id: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

const toHashed = (r: Row): HashedEntry => ({
  seq: Number(r.seq),
  at: r.at.toISOString(),
  actor: r.actor,
  actorKind: r.actor_kind,
  action: r.action,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  data: r.data,
});

const toEntry = (r: Row): AuditEntry => ({ ...toHashed(r), prevHash: r.prev_hash, hash: r.hash });

/**
 * The audit log: every change, each entry carrying the hash of the one before, so changing or removing any entry breaks
 * the chain from there on. Appends take a transaction-scoped lock, so the chain has one head and no gaps; append inside
 * the transaction that makes the change, and the entry exists exactly when the change does.
 */
export class AuditLog {
  constructor(private readonly sql: Sql) {}

  async append(input: AuditInput, tx: Tx = this.sql): Promise<AuditEntry> {
    return inTransaction(tx, async (t) => {
      await t`SELECT pg_advisory_xact_lock(hashtext('landledger:audit'))`;
      const [head] = await t<
        { seq: string; hash: string }[]
      >`SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`;
      const prevHash = head?.hash ?? GENESIS;
      const entry: HashedEntry = {
        seq: head ? Number(head.seq) + 1 : 1,
        at: new Date().toISOString(),
        actor: input.actor,
        actorKind: input.actorKind,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        data: input.data ?? {},
      };
      const hash = chainHash(prevHash, entry);
      await t`
        INSERT INTO audit_log (seq, at, actor, actor_kind, action, subject_type, subject_id, data, prev_hash, hash)
        VALUES (${entry.seq}, ${entry.at}, ${entry.actor}, ${entry.actorKind}, ${entry.action}, ${entry.subjectType},
                ${entry.subjectId}, ${t.json(entry.data as never)}, ${prevHash}, ${hash})`;
      return { ...entry, prevHash, hash };
    });
  }

  /** Newest first. */
  async list(input: { limit: number; before?: number | null }): Promise<{ entries: AuditEntry[]; total: number }> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM audit_log
      WHERE ${input.before ?? null}::bigint IS NULL OR seq < ${input.before ?? null}::bigint
      ORDER BY seq DESC LIMIT ${input.limit}`;
    const [{ total }] = await this.sql<{ total: string }[]>`SELECT coalesce(max(seq), 0) AS total FROM audit_log`;
    return { entries: rows.map(toEntry), total: Number(total) };
  }

  /** Walks the whole chain in order: each seq follows the last, each prev_hash is the last hash, each hash recomputes. */
  async verify(batch = 1000): Promise<AuditVerify> {
    let prev = GENESIS;
    let expected = 1;
    let checked = 0;
    for (;;) {
      const rows = await this.sql<Row[]>`
        SELECT * FROM audit_log WHERE seq >= ${expected} ORDER BY seq LIMIT ${batch}`;
      if (rows.length === 0) break;
      for (const r of rows) {
        const seq = Number(r.seq);
        const fail = (reason: string): AuditVerify => ({
          ok: false,
          checked,
          head: checked ? prev : null,
          brokenAt: seq,
          reason,
        });
        if (seq !== expected) return { ...fail(`entry ${expected} is missing`), brokenAt: expected };
        if (r.prev_hash !== prev) return fail(`entry ${seq} doesn't carry the hash of entry ${seq - 1}`);
        let recomputed: string;
        try {
          recomputed = chainHash(prev, toHashed(r));
        } catch (error) {
          return fail(`entry ${seq} can't be hashed: ${(error as Error).message}`);
        }
        if (recomputed !== r.hash) return fail(`entry ${seq} was changed after it was written`);
        prev = r.hash;
        expected = seq + 1;
        checked++;
      }
    }
    return { ok: true, checked, head: checked ? prev : null, brokenAt: null, reason: null };
  }
}
