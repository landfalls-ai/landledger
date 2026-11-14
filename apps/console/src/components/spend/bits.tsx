import type { BudgetState } from '@landledger/contracts';
import type { ReactNode } from 'react';
import { Pill, Tag } from '@/components/ui/pill';
import { cn } from '@/lib/cn';

export const STATE_LABEL: Record<BudgetState, string> = {
  ok: 'On track',
  risk: 'At risk',
  over: 'Over',
  none: 'No budget',
};

export function StatePill({ state }: { state: BudgetState }) {
  return <Pill tone={state === 'none' ? 'nu' : state}>{STATE_LABEL[state]}</Pill>;
}

/** Every figure says what it is (docs/ui.md): estimated (dashed) or invoiced. */
export const Estimated = () => <Tag dashed>estimated</Tag>;
export const Invoiced = () => <Tag>invoiced</Tag>;

/** One of the four headline figures (the prototype's `.stat`). */
export function Stat({
  label,
  value,
  children,
  testId,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-[14px] border border-hair bg-sf px-3.5 py-[13px] md:p-4" data-testid={testId}>
      <div className="text-[12px] text-t3">{label}</div>
      <div className="figure my-[3px] whitespace-nowrap text-[21px] font-semibold tracking-[-0.02em] text-t1 md:text-[26px]">
        {value}
      </div>
      {children && <div className="text-[12px] leading-[1.35] text-t2">{children}</div>}
    </div>
  );
}

/** A row of chips (group by, filters): one line that scrolls sideways on a phone. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">{label}</p>
      <div
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0"
        role="group"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

export function Chip({
  pressed,
  onClick,
  children,
  filter,
}: {
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  filter?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={filter ? undefined : pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-2xl border border-bd bg-sf px-3 text-[13px] text-t2',
        pressed && 'border-ac2 bg-ac2 font-medium text-on-ac',
        filter && 'bg-acdim text-t1',
      )}
    >
      {children}
    </button>
  );
}

/** A note under a card or above the page: muted, small. */
export const Lede = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={cn('mb-3.5 text-[13px] text-t2', className)}>{children}</p>
);

export const Legend = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 pt-2.5 text-[12px] text-t2">{children}</div>
);

export const Swatch = ({ color, line, dashed }: { color: string; line?: boolean; dashed?: boolean }) =>
  line ? (
    <i
      className="mr-1.5 inline-block w-4 align-middle"
      style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }}
    />
  ) : (
    <i className="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={{ background: color }} />
  );

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="rounded-[14px] border border-rdbd bg-rddim px-4 py-3 text-[13px] text-rd">{error.message}</div>
  );
}
