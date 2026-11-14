import { cn } from '@/lib/cn';

/** The product mark: the prototype's `LL` tile. */
export function Mark({ size, className }: { size: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center bg-ac font-bold tracking-[0.02em] text-on-ac',
        size === 'md' ? 'size-[34px] rounded-[9px] text-[12px]' : 'size-7 rounded-[8px] text-[11px]',
        className,
      )}
    >
      LL
    </span>
  );
}
