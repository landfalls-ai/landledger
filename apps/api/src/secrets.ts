/**
 * Secrets at rest (review of wave 1): the ID token a session keeps for sign-out and each webhook's signing secret are
 * sealed with AES-256-GCM under LANDLEDGER_SECRET_KEY, with the row they belong to as additional data (a sealed value
 * copied to another row doesn't open). Stored as `enc:v1:<base64url(iv ‖ ciphertext ‖ tag)>`. Without a key nothing
 * secret is stored: sessions keep no ID token (sign-out then skips the hint) and webhooks can't be created.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Sql } from './db.js';

const PREFIX = 'enc:v1:';

export const isSealed = (value: string) => value.startsWith(PREFIX);

/** A 32-byte key from base64, base64url or hex text; throws on anything else. */
export function parseSecretKey(text: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== 32)
    throw new Error('LANDLEDGER_SECRET_KEY is 32 bytes, as base64 or hex (openssl rand -base64 32)');
  return key;
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('A secret box key is 32 bytes');
  }

  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  open(sealed: string, aad: string): string {
    if (!isSealed(sealed)) throw new Error('Not a sealed value');
    const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  }
}

export const sessionAad = (sessionId: string) => `sessions.id_token:${sessionId}`;
export const webhookAad = (webhookId: string) => `webhooks.secret:${webhookId}`;

/**
 * Rows written before secrets were sealed: with a key, sealed in place; without one, ID tokens are dropped (a session
 * works without one). Returns how many rows changed. Run at start.
 */
export async function sealLegacySecrets(sql: Sql, box: SecretBox | null): Promise<number> {
  let changed = 0;
  if (!box) {
    changed += (
      await sql`UPDATE sessions SET id_token = NULL WHERE id_token IS NOT NULL AND id_token NOT LIKE 'enc:v1:%'`
    ).count;
    return changed;
  }
  const sessions = await sql<{ id: string; id_token: string }[]>`
    SELECT id, id_token FROM sessions WHERE id_token IS NOT NULL AND id_token NOT LIKE 'enc:v1:%'`;
  for (const s of sessions)
    changed += (await sql`UPDATE sessions SET id_token = ${box.seal(s.id_token, sessionAad(s.id))} WHERE id = ${s.id}`)
      .count;
  const hooks = await sql<{ id: string; secret: string }[]>`
    SELECT id, secret FROM webhooks WHERE secret NOT LIKE 'enc:v1:%'`;
  for (const h of hooks)
    changed += (await sql`UPDATE webhooks SET secret = ${box.seal(h.secret, webhookAad(h.id))} WHERE id = ${h.id}`)
      .count;
  return changed;
}
