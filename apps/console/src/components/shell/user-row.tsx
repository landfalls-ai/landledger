import type { Me } from '@landledger/contracts';
import { LogOut } from 'lucide-react';
import { Link } from 'react-router';
import { initials, roleLine, signOut } from '@/lib/auth';

/** The signed-in person: initials, name, "Finance · controller", and sign out. */
export function UserRow({ me }: { me: Me }) {
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="user-row">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full border border-hair bg-acdim text-[10.5px] font-semibold text-t1"
      >
        {initials(me.user.name)}
      </span>
      <Link to="/profile" className="min-w-0 flex-1 leading-tight hover:underline" title="Your profile and Link Slack">
        <b className="block truncate text-[13px] font-semibold text-t1">{me.user.name}</b>
        <small className="block truncate text-[11.5px] text-t3" title={me.user.email ?? undefined}>
          {roleLine(me)}
        </small>
      </Link>
      {me.kind === 'person' && (
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void signOut()}
          className="-mr-1 grid size-6 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
        >
          <LogOut className="size-3.5" />
        </button>
      )}
    </div>
  );
}
