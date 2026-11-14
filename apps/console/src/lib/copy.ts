/**
 * "Copy for Excel" (docs/ui.md): tab-separated rows with a header row. Money and rates go in plain (no symbol, no
 * grouping) so Excel reads them as numbers.
 */
export function toTsv(header: string[], rows: string[][]): string {
  const clean = (cell: string) => cell.replace(/[\t\r\n]+/g, ' ').trim();
  return [header, ...rows].map((r) => r.map(clean).join('\t')).join('\n');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
