import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The prototype's `.card`: a surface with a hairline border, a header (title, a line under it, an action), a body. */
export function Card({
  title,
  sub,
  action,
  children,
  className,
  testId,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-[14px] border border-hair bg-sf', className)} data-testid={testId}>
      {(title || action) && (
        <div className="flex min-h-11 flex-wrap items-center gap-2.5 px-4 pt-3.5">
          <h2 className="min-w-0 flex-1 text-[14px] font-semibold text-t1">
            {title}
            {sub && <small className="mt-px block text-[12px] font-normal text-t3">{sub}</small>}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 pb-4 pt-3', className)}>{children}</div>;
}
