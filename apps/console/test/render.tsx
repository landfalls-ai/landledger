import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../src/router';

export const ME = {
  kind: 'person',
  user: {
    id: 'usr_1',
    name: 'Yoav Ben David',
    email: 'yoav.bendavid@landbright.test',
    roles: ['controller'],
    groups: ['Finance Controllers'],
  },
  scopes: ['read', 'requests:write', 'admin'],
  authMode: 'oidc',
};

/** Answers the console's GETs from a map of path → [status, body]. */
export function mockApi(answers: Record<string, [number, unknown]>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input.toString();
    const hit = Object.entries(answers).find(([p]) => path === p || path.startsWith(`${p}?`));
    const [status, body] = hit?.[1] ?? [404, { error: { code: 'not_found', message: `No route ${path}` } }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
