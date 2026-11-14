import { CalendarDays } from 'lucide-react';
import { Mark } from './mark';

const monthLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The sticky top bar: the LL tile on a phone, the screen's title, and the period. Periods (open, closing, locked)
 * arrive with month-end in wave 4; until then it names the current month only.
 */
export function TopBar({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-20 flex h-[60px] items-center gap-3 border-b border-hair bg-bg px-4 md:h-[52px] md:px-6">
      <Mark size="md" className="md:hidden" />
      <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-t1">{title}</h1>
      <span
        className="flex h-[38px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-bd bg-sf px-3 font-medium text-t1"
        title="Periods and their close arrive in wave 4"
        data-testid="period"
      >
        <CalendarDays className="size-[18px]" strokeWidth={1.75} />
        {monthLabel(new Date())}
        <span className="hidden font-normal text-t3 md:inline">· current month</span>
      </span>
    </header>
  );
}
