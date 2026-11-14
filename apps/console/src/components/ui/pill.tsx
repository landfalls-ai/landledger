import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type PillTone = 'ok' | 'risk' | 'over' | 'nu';

/** State as a shape as well as a colour (docs/ui.md): a dot for on track, a triangle for at risk, a diamond for over. */
const SHAPE: Partial<Record<PillTone, ReactNode>> = {
  ok: <circle cx="4" cy="4" r="3.5" />,
  risk: <path d="M4 .5 8 7.5H0z" />,
  over: <path d="M4 0 8 4 4 8 0 4z" />,
};

export function Pill({
  tone = 'nu',
  children,
  className,
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-[11px] border px-2 text-[12px] font-medium',
        tone === 'nu' && 'border-hair bg-nudim text-t2',
        tone === 'ok' && 'border-gnbd bg-gndim text-gn',
        tone === 'risk' && 'border-warnbd bg-warndim text-warn',
        tone === 'over' && 'border-rdbd bg-rddim text-rd',
        className,
      )}
    >
      {SHAPE[tone] && (
        <svg viewBox="0 0 8 8" className="size-2 fill-current" aria-hidden>
          {SHAPE[tone]}
        </svg>
      )}
      {children}
    </span>
  );
}

/** A small mono tag: `estimated` (dashed) or `invoiced`, or any other label such as `dev seed`. */
export function Tag({ children, dashed, className }: { children: ReactNode; dashed?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-[4px] border border-acbd px-[5px] align-[1px] font-mono text-[10.5px] font-medium leading-4 text-t2',
        dashed && 'border-dashed',
        className,
      )}
    >
      {children}
    </span>
  );
}
