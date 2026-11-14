import type { Me } from '@landledger/contracts';
import { Ellipsis, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cn } from '@/lib/cn';
import { ALL_PAGES, NAV_GROUPS, pageOf } from '@/nav';
import { APPROVALS_WAITING, Count } from './sidebar';
import { ThemeToggle } from './theme-toggle';
import { UserRow } from './user-row';

/** The phone's navigation (below md): Overview, Explore, Approvals and More, a sheet with the rest by group. */
export function BottomBar({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const [moreOn, setMoreOn] = useState<string | null>(null);
  const more = moreOn === pathname;
  const bar = ALL_PAGES.filter((p) => p.bar);
  const inRest = pageOf(pathname) && !pageOf(pathname)!.bar;
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 flex items-end bg-overlay md:hidden" onClick={() => setMoreOn(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More screens"
            onClick={(e) => e.stopPropagation()}
            className="pb-safe max-h-[86dvh] w-full animate-in overflow-y-auto rounded-t-[18px] bg-sf px-3 pt-2"
          >
            <div className="flex items-center justify-between">
              <div className="mx-auto my-1 h-1 w-9 rounded-sm bg-bd" aria-hidden />
              <button
                type="button"
                aria-label="Close"
                onClick={() => setMoreOn(null)}
                className="absolute right-4 grid size-8 place-items-center rounded-full text-t3 hover:bg-acdim"
              >
                <X className="size-4" />
              </button>
            </div>
            {NAV_GROUPS.map((group) => {
              const items = group.items.filter((i) => !i.bar);
              if (!items.length) return null;
              return (
                <div key={group.label}>
                  <h2 className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">
                    {group.label}
                  </h2>
                  {items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.href}
                        to={item.href}
                        onClick={() => setMoreOn(null)}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded-[10px] px-2.5 py-[13px] text-[15px] text-t1',
                            isActive && 'bg-acdim font-semibold',
                          )
                        }
                      >
                        <Icon className="size-[18px] text-t2" strokeWidth={1.75} />
                        {item.label}
                      </NavLink>
                    );
                  })}
                </div>
              );
            })}
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-hair px-2.5 pb-4 pt-3">
              <UserRow me={me} />
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
      <nav
        aria-label="Screens"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-hair bg-bg md:hidden"
        data-testid="bottom-bar"
      >
        {bar.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn(
                  'relative flex min-h-14 flex-col items-center gap-[3px] px-0.5 pb-2 pt-[9px] text-[11px]',
                  isActive ? 'font-semibold text-t1' : 'text-t3',
                )
              }
            >
              <Icon className="size-[22px]" strokeWidth={1.75} />
              {item.label}
              {item.href === '/approvals' && (
                <span className="absolute left-[calc(50%+6px)] top-[5px]">
                  <Count n={APPROVALS_WAITING} />
                </span>
              )}
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOn(more ? null : pathname)}
          aria-haspopup="dialog"
          aria-expanded={more}
          className={cn(
            'flex min-h-14 flex-col items-center gap-[3px] px-0.5 pb-2 pt-[9px] text-[11px]',
            more || inRest ? 'font-semibold text-t1' : 'text-t3',
          )}
        >
          <Ellipsis className="size-[22px]" strokeWidth={1.75} />
          More
        </button>
      </nav>
    </>
  );
}
