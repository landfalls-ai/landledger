/**
 * Canonical JSON for hashing: object keys sorted (by UTF-16 code unit), no whitespace, strings as JSON.stringify
 * writes them. Only values that survive a round trip through Postgres jsonb unchanged are allowed: strings, booleans,
 * null, safe integers, arrays and plain objects. Money goes in as minor units in a string, decimals as strings; a float
 * or a bigint is refused, so a hash computed today is the hash recomputed from the stored row tomorrow.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`Canonical JSON takes safe integers only, got ${value}`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError(`Canonical JSON takes plain objects only, got ${proto?.constructor?.name ?? 'unknown'}`);
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [k, v] of entries) if (v === undefined) throw new TypeError(`Canonical JSON has no undefined (${k})`);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Canonical JSON can't hold a ${typeof value}`);
  }
}
