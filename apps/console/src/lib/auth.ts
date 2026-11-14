import { type Me, ROLE_LABEL, type Role } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { get, send } from './api';

/** Who is signed in; a 401 means "Sign in with Landbright" (the shell shows the sign-in page). */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/auth/me'), retry: false, staleTime: 60_000 });
}

const ORDER: Role[] = ['cfo', 'controller', 'fpa', 'budget_owner', 'auditor', 'engineer'];

/** "Finance · controller", as the prototype labels people. */
export function roleLine(me: Me): string {
  if (me.kind === 'dev') return 'Local developer · dev bypass';
  if (me.kind !== 'person') return `API key · ${me.scopes.join(', ')}`;
  const top = ORDER.find((r) => me.user.roles.includes(r));
  if (!top) return 'No Landledger role';
  const area = top === 'engineer' ? 'Engineering' : top === 'auditor' ? 'Audit' : 'Finance';
  return `${area} · ${ROLE_LABEL[top].toLowerCase()}`;
}

/** Starts sign-in at Landbright, coming back to `returnTo`. */
export function signIn(returnTo = window.location.pathname + window.location.search): void {
  const back = returnTo.replace(/[?&]signin_error=[^&]*/, '').replace(/^\/?$/, '/') || '/';
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(back)}`);
}

export async function signOut(): Promise<void> {
  try {
    const body = await send<{ redirect?: string } | undefined>('POST', '/api/auth/logout');
    window.location.assign(body?.redirect ?? '/');
  } catch {
    window.location.assign('/');
  }
}

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
};
