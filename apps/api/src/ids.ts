import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';

/** A prefixed random id (`usr_…`, `key_…`, `wh_…`): 20 characters from a 54-letter alphabet, ~115 bits. */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A random secret for a cookie, a PKCE verifier or a state: 32 bytes, base64url. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
