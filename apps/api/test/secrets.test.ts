import { describe, expect, it } from 'vitest';
import { isSealed, parseSecretKey, SecretBox, sessionAad, webhookAad } from '../src/secrets.js';

const box = new SecretBox(Buffer.alloc(32, 7));

describe('secrets at rest', () => {
  it('seals with AES-256-GCM, bound to its row: another row or a changed byte does not open', () => {
    const sealed = box.seal('whsec_abc', webhookAad('wh_1'));
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('whsec_abc');
    expect(box.open(sealed, webhookAad('wh_1'))).toBe('whsec_abc');
    expect(box.seal('whsec_abc', webhookAad('wh_1'))).not.toBe(sealed); // a fresh IV each time
    expect(() => box.open(sealed, webhookAad('wh_2'))).toThrow();
    expect(() => box.open(sealed, sessionAad('wh_1'))).toThrow();
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => box.open(tampered, webhookAad('wh_1'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(16)).seal('x', 'y')).toThrow();
  });

  it('reads the key as 32 bytes of base64 or hex, nothing else', () => {
    expect(parseSecretKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
    expect(parseSecretKey('ab'.repeat(32))).toHaveLength(32);
    expect(() => parseSecretKey('short')).toThrow(/32 bytes/);
  });
});
