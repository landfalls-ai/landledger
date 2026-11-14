import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'default' | 'primary' | 'danger';

/** The prototype's `.btn`: hairline border, 36 px (30 px small, 48 px big), primary in the accent. */
export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-[7px] whitespace-nowrap border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-[30px] rounded-[9px] px-2.5 text-[12.5px]',
        size === 'md' && 'h-9 rounded-[9px] px-[13px] text-[14px]',
        size === 'lg' && 'h-12 rounded-xl px-5 text-[15px] font-semibold',
        variant === 'default' && 'border-bd bg-sf text-t1 hover:bg-acdim',
        variant === 'primary' && 'border-ac2 bg-ac2 text-on-ac hover:bg-ac2-hover',
        variant === 'danger' && 'border-rdbd bg-sf text-rd hover:bg-rddim',
        className,
      )}
    />
  );
}
