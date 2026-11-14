import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** Right-aligned mono figures. */
  numeric?: boolean;
  /** On a phone, the whole width of the card (a bar, a long value), label above. */
  full?: boolean;
}

/**
 * A table on desktop; on a phone each row becomes a card (the first column as its title, the rest as label and value
 * pairs), as the prototype's `.t.cards` does: one column, no sideways scrolling.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  testId?: string;
}) {
  if (rows.length === 0)
    return <div className="px-4 py-7 text-center text-[13px] text-t3">{empty ?? 'Nothing yet.'}</div>;
  const [first, ...rest] = columns;
  return (
    <div data-testid={testId}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.header}
                  className={cn(
                    'whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-t3 first:pl-4 last:pr-4',
                    c.numeric && 'text-right',
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td
                    key={c.header}
                    className={cn(
                      'border-t border-hair px-3 py-[11px] align-middle text-[14px] first:pl-4 last:pr-4',
                      c.numeric && 'figure whitespace-nowrap text-right',
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="grid grid-cols-2 gap-x-[18px] gap-y-[7px] border-t border-hair px-4 py-3.5">
            <div className="col-span-2 mb-0.5 text-[14px]">{first!.cell(row)}</div>
            {rest.map((c) => (
              <div
                key={c.header}
                className={cn(
                  'flex min-w-0 items-baseline justify-between gap-2 text-right text-[14px]',
                  c.full && 'col-span-2 flex-col items-stretch gap-1 text-left',
                )}
              >
                <span className="shrink-0 text-left text-[12px] text-t3">{c.header}</span>
                <span className={cn('min-w-0', c.numeric && 'figure')}>{c.cell(row)}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
