import type { Me } from '@landledger/contracts';
import { Link, NavLink } from 'react-router';
import { cn } from '@/lib/cn';
import { NAV_GROUPS, type NavItem } from '@/nav';
import { Mark } from './mark';
import { ThemeToggle } from './theme-toggle';
import { UserRow } from './user-row';

/** Waiting approvals; requests arrive in wave 2, so the count is hidden at zero. */
export const APPROVALS_WAITING = 0;

export function Count({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span
      className="figure grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-ac px-[5px] text-[11px] font-semibold text-on-ac"
      aria-label={`${n} waiting`}
    >
      {n}
    </span>
  );
}

function Row({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.href}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-[11px] rounded-lg px-2.5 py-2 text-[14px] transition-colors duration-[120ms]',
          isActive ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
        )
      }
    >
      <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
      <span className="truncate">{item.label}</span>
      {item.href === '/approvals' && (
        <span className="ml-auto">
          <Count n={APPROVALS_WAITING} />
        </span>
      )}
    </NavLink>
  );
}

/** The left rail from md up, after the prototype: the LL tile, the five groups, the theme and the person. */
export function Sidebar({ me }: { me: Me }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[208px] shrink-0 flex-col overflow-y-auto border-r border-hair px-2 pb-2.5 pt-3.5 md:flex">
      <Link to="/overview" className="flex items-center gap-2.5 px-2 pb-3.5 font-semibold text-t1">
        <Mark size="md" />
        Landledger
      </Link>
      <nav aria-label="Screens" className="flex flex-col">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5" data-testid={`nav-${group.label}`}>
            <h2 className="px-2.5 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">
              {group.label}
            </h2>
            {group.items.map((item) => (
              <Row key={item.href} item={item} />
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3 px-1 pt-2.5">
        <ThemeToggle />
        <div className="border-t border-hair px-1.5 pt-3">
          <UserRow me={me} />
        </div>
      </div>
    </aside>
  );
}
