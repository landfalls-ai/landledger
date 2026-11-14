import type { WebhookEvent, WebhookInput } from '@landledger/contracts';
import { createHmac, randomBytes } from 'node:crypto';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { isSealed, type SecretBox, webhookAad } from './secrets.js';

/** Standard Webhooks retry schedule: the wait after each failed attempt; after the last one the delivery fails. */
export const RETRY_DELAYS_S = [5, 30, 120, 600, 1800];
const TIMEOUT_MS = 10_000;
/** A claimed delivery is hidden from other dispatchers for this long, so a crash mid-send retries it later. */
const LEASE_S = 60;

/** The Standard Webhooks signature: `v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>`. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEvent[];
  description: string;
  createdBy: string;
  createdAt: string;
}

type Row = {
  id: string;
  url: string;
  events: WebhookEvent[];
  description: string;
  created_by: string;
  created_at: Date;
};
const toView = (r: Row): WebhookView => ({
  id: r.id,
  url: r.url,
  events: r.events,
  description: r.description,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

type Due = {
  id: string;
  event_id: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
  webhook_id: string;
};

/**
 * Webhooks out, Clickland's outbox pattern: `enqueue` writes one `outbox` row per subscriber inside the caller's
 * transaction (so an event exists exactly when its change does); the dispatcher claims due rows with a lease
 * (`FOR UPDATE SKIP LOCKED`), signs them (Standard Webhooks), retries on the schedule, then keeps them as failed.
 */
export class Webhooks {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Seals signing secrets at rest (secrets.ts); without it webhooks can't be created. */
    private readonly box: SecretBox | null = null,
  ) {}

  /** A stored secret as the signer needs it: sealed ones opened; a legacy plaintext one as is (sealed at start). */
  private secretOf(webhookId: string, stored: string): string {
    if (!isSealed(stored)) return stored;
    if (!this.box) throw new Error('LANDLEDGER_SECRET_KEY is not set: sealed webhook secrets cannot be opened');
    return this.box.open(stored, webhookAad(webhookId));
  }

  async list(): Promise<WebhookView[]> {
    const rows = await this.sql<Row[]>`SELECT * FROM webhooks WHERE disabled_at IS NULL ORDER BY created_at DESC`;
    return rows.map(toView);
  }

  /** The signing secret is returned only here, once. */
  async create(input: WebhookInput, by: Principal): Promise<WebhookView & { secret: string }> {
    const box = this.box;
    if (!box)
      throw new ApiError(
        'unavailable',
        'Webhook secrets are sealed at rest: set LANDLEDGER_SECRET_KEY (openssl rand -base64 32) to create webhooks',
      );
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    const actor = actorOf(by);
    const id = newId('wh');
    return (await this.sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO webhooks (id, url, secret, events, description, created_by)
        VALUES (${id}, ${input.url}, ${box.seal(secret, webhookAad(id))}, ${input.events}, ${input.description}, ${actor.actor})
        RETURNING *`;
      await this.audit.append(
        {
          ...actor,
          action: 'webhook.created',
          subjectType: 'webhook',
          subjectId: row!.id,
          data: { url: input.url, events: input.events },
        },
        tx,
      );
      return { ...toView(row!), secret };
    })) as WebhookView & { secret: string };
  }

  async delete(id: string, by: Principal): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE webhooks SET disabled_at = now() WHERE id = ${id} AND disabled_at IS NULL RETURNING id`;
      if (rows.length === 0) throw notFound('Webhook');
      await tx`UPDATE outbox SET status = 'failed', last_error = 'webhook deleted' WHERE webhook_id = ${id} AND status = 'pending'`;
      await this.audit.append({ ...actorOf(by), action: 'webhook.deleted', subjectType: 'webhook', subjectId: id }, tx);
    });
  }

  /** Queues one event for every subscriber that wants it (or only `onlyWebhook`). Returns the event id. */
  async enqueue(
    tx: Tx,
    type: WebhookEvent,
    data: unknown,
    onlyWebhook: string | null = null,
  ): Promise<{ eventId: string; deliveries: number }> {
    const eventId = newId('evt');
    const payload = { type, timestamp: new Date().toISOString(), data };
    const hooks = await tx<{ id: string }[]>`
      SELECT id FROM webhooks
      WHERE disabled_at IS NULL AND ${type} = ANY (events) AND (${onlyWebhook}::text IS NULL OR id = ${onlyWebhook})`;
    for (const hook of hooks)
      await tx`
        INSERT INTO outbox (id, webhook_id, event_id, event_type, payload)
        VALUES (${newId('whd')}, ${hook.id}, ${eventId}, ${type}, ${tx.json(payload as never)})`;
    return { eventId, deliveries: hooks.length };
  }

  /** Sends what is due. Safe in several processes: each claims rows with a lease. Returns how many it sent. */
  async dispatchDue(limit = 20): Promise<number> {
    const due = await this.sql<Due[]>`
      UPDATE outbox o SET next_attempt_at = now() + make_interval(secs => ${LEASE_S})
      FROM webhooks w
      WHERE o.id IN (
        SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) AND w.id = o.webhook_id
      RETURNING o.id, o.event_id, o.payload, o.attempts, w.url, w.secret, w.id AS webhook_id`;
    await Promise.all(due.map((d) => this.send(d)));
    return due.length;
  }

  private async send(d: Due): Promise<void> {
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const secret = this.secretOf(d.webhook_id, d.secret);
      const res = await this.fetchImpl(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Landledger-Webhooks/0.1',
          'webhook-id': d.event_id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(secret, d.event_id, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = d.attempts + 1;
    if (error === null)
      await this.sql`
        UPDATE outbox SET status = 'delivered', attempts = ${attempts}, delivered_at = now(), last_error = null
        WHERE id = ${d.id}`;
    else if (attempts > RETRY_DELAYS_S.length)
      await this.sql`
        UPDATE outbox SET status = 'failed', attempts = ${attempts}, last_error = ${error.slice(0, 500)} WHERE id = ${d.id}`;
    else
      await this.sql`
        UPDATE outbox SET attempts = ${attempts}, last_error = ${error.slice(0, 500)},
          next_attempt_at = now() + make_interval(secs => ${RETRY_DELAYS_S[attempts - 1]!})
        WHERE id = ${d.id}`;
  }

  async deliveries(webhookId: string, limit = 50) {
    const [hook] = await this.sql`SELECT id FROM webhooks WHERE id = ${webhookId}`;
    if (!hook) throw notFound('Webhook');
    const rows = await this.sql<
      {
        id: string;
        event_id: string;
        event_type: string;
        status: string;
        attempts: number;
        last_error: string | null;
        created_at: Date;
        delivered_at: Date | null;
      }[]
    >`
      SELECT id, event_id, event_type, status, attempts, last_error, created_at, delivered_at
      FROM outbox WHERE webhook_id = ${webhookId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      type: r.event_type,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at.toISOString(),
      deliveredAt: r.delivered_at?.toISOString() ?? null,
    }));
  }
}
