import type { Me } from '@landledger/contracts';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { ApiError } from '@/lib/api';
import { signIn, useMe } from '@/lib/auth';
import { pageOf } from '@/nav';
import { Button } from '../ui/button';
import { BottomBar } from './bottom-bar';
import { Mark } from './mark';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/** Why a sign-in came back without a session (the API redirects to `?signin_error=<code>`). */
export const SIGN_IN_ERRORS: Record<string, string> = {
  no_role:
    'Your Landbright account isn’t in a Landledger group. Ask for Finance CFO, Finance Controllers, Finance FP&A, Budget Owners, Landledger Auditors or Engineering.',
  inactive:
    'Your Landledger account is turned off (Landbright deprovisioned it). Ask an administrator to turn it back on.',
  expired: 'That sign-in took too long or started in another browser. Try again.',
  denied: 'Landbright didn’t sign you in.',
  unavailable: 'Landbright isn’t answering. Try again in a moment.',
  failed: 'Sign-in didn’t complete. Try again.',
};

/**
 * The console. Without a session it is the sign-in page ("Sign in with Landbright"); with one, the sidebar (md and up)
 * or the bottom bar (phones), the top bar and the screen.
 */
export function AppShell() {
  const me = useMe();
  const { search } = useLocation();
  if (me.data) return <Frame me={me.data} />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    const details = me.error.details as { signIn?: string; problem?: string } | undefined;
    const error = new URLSearchParams(search).get('signin_error');
    const off = details?.signIn === 'unavailable';
    return (
      <Gate
        title="Sign in to Landledger"
        hint="Landledger uses your Landbright account. Your Landbright groups decide what you can see and do."
        message={
          off
            ? `Sign-in with Landbright isn’t set up on this machine yet: ${details?.problem ?? ''}`
            : error
              ? (SIGN_IN_ERRORS[error] ?? SIGN_IN_ERRORS.failed)
              : undefined
        }
        action={
          <Button variant="primary" size="lg" disabled={off} onClick={() => signIn()} className="w-full max-w-[320px]">
            Sign in with Landbright
          </Button>
        }
      />
    );
  }
  if (me.isError)
    return (
      <Gate
        title="Can’t reach the Landledger API"
        hint={
          <>
            The console sends <code className="font-mono text-[12px]">/api</code> to the API on 127.0.0.1:4810. Start it
            with <code className="font-mono text-[12px]">pnpm serve</code>, and Postgres with{' '}
            <code className="font-mono text-[12px]">pnpm dev:up</code>.
          </>
        }
        message={me.error.message}
        action={<Button onClick={() => void me.refetch()}>Try again</Button>}
      />
    );
  return <Gate icon={<Loader2 className="size-5 animate-spin" />} title="Opening Landledger…" />;
}

function Frame({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const title = pathname.startsWith('/approvals/') ? 'Request' : (pageOf(pathname)?.label ?? 'Landledger');
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[208px_minmax(0,1fr)]">
      <Sidebar me={me} />
      <div className="min-w-0">
        <TopBar title={title} />
        <main className="max-w-[1280px] px-4 pb-[104px] pt-4 outline-none md:px-6 md:pb-12 md:pt-5" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <BottomBar me={me} />
    </div>
  );
}

function Gate({
  icon,
  title,
  hint,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6" data-testid="gate">
      <div className="flex w-full max-w-[400px] flex-col items-center gap-2.5 text-center">
        <Mark size="md" className="mb-1 size-11 rounded-xl text-[14px]" />
        {icon && <div className="text-t3">{icon}</div>}
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-t1">{title}</h1>
        {hint && <div className="text-[13px] leading-snug text-t2">{hint}</div>}
        {message && (
          <div
            className="mt-1 w-full rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-left text-[13px] text-t1"
            role="alert"
          >
            {message}
          </div>
        )}
        {action && <div className="mt-3 flex w-full justify-center">{action}</div>}
        <p className="mt-4 text-[12px] text-t3">The cost subledger for technology and AI spend.</p>
      </div>
    </div>
  );
}
