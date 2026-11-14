/**
 * CSV files people import (budgets, invoices, contracts): RFC 4180 cells (quotes, doubled quotes, commas inside
 * quotes), a header row, and every problem reported with its line number so a bad file imports nothing.
 */

/** The cells of one line: quoted cells may hold commas and doubled quotes; every cell is trimmed. */
export function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** A header name as compared: lower case, spaces to underscores (`Invoice Number` is `invoice_number`). */
export const headerName = (h: string) => h.toLowerCase().trim().replace(/\s+/g, '_');

export interface CsvRow {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  get(name: string): string;
}

/**
 * Reads a CSV with a header naming at least `required` (any order, any case); `optional` columns may be absent.
 * Unknown columns are a problem, so a typo isn't silently ignored. Blank lines are skipped.
 */
export function readCsv(
  csv: string,
  required: readonly string[],
  optional: readonly string[] = [],
): { rows: CsvRow[]; problems: string[] } {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const head = cells(lines[0] ?? '').map(headerName);
  const problems: string[] = [];
  const missing = required.filter((r) => !head.includes(r));
  if (missing.length) problems.push(`Line 1: the header is missing ${missing.join(', ')} (${required.join(',')})`);
  const known = new Set([...required, ...optional]);
  const unknown = head.filter((h) => h && !known.has(h));
  if (unknown.length) problems.push(`Line 1: unknown column(s) ${unknown.join(', ')}`);
  if (problems.length) return { rows: [], problems };
  const rows: CsvRow[] = [];
  lines.slice(1).forEach((text, i) => {
    if (!text.trim()) return;
    const values = cells(text);
    const line = i + 2;
    if (values.length > head.length)
      problems.push(`Line ${line}: ${values.length} cells, the header has ${head.length}`);
    rows.push({ line, get: (name) => values[head.indexOf(name)] ?? '' });
  });
  if (!rows.length && !problems.length) problems.push('The file has a header and no rows');
  return { rows, problems };
}
