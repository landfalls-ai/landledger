/**
 * Fakes of Landflow and Clickland for the integration tests: what they answer can change between runs, as a real
 * source's late data would. `sources.state` is what they hold now.
 */
import type { Config } from '../src/config.js';
import type { Principal } from '../src/principal.js';

export const testConfig = (over: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  postgresUrl: '',
  consoleUrl: 'http://localhost:4811',
  bootstrapKey: 'll_bootstrap_test_key_0000000000000000',
  devAuth: true,
  sessionHours: 8,
  oidc: null,
  oidcProblem: 'tests',
  backgroundJobs: false,
  landflow: { url: 'http://landflow.test', key: 'lf_test', service: 'landflow-host', namespace: 'landflow-dev' },
  clickland: { url: 'http://clickland.test', key: 'ck_test', labels: [] },
  clicklandConsoleUrl: 'http://localhost:4711',
  costMetricsEndpoint: null,
  ingestJobs: false,
  ...over,
});

export const person = (id: string, email: string, roles: Principal['roles']): Principal => ({
  kind: 'person',
  id,
  name: email,
  email,
  roles,
  groups: [],
  scopes: ['read', 'admin'],
});
export const YOAV = person('usr_yoav', 'yoav.bendavid@landbright.test', ['controller']);
export const DANA = person('usr_dana', 'dana.shalev@landbright.test', ['cfo']);
export const TAL = person('usr_tal', 'tal.levi@landbright.test', ['engineer']);
export const KEY: Principal = {
  kind: 'key',
  id: 'key_1',
  name: 'ingest bot',
  email: null,
  roles: [],
  groups: [],
  scopes: ['admin'],
};

export const call = (at: string, input: number, output: number, extra: Record<string, number> = {}, cost = 0) => ({
  id: `ev_${at}_${input}`,
  at,
  kind: 'ai.call',
  agentId: 'ag_1',
  workflowId: null,
  actorId: 'usr_x',
  cost,
  attrs: { provider: 'anthropic', model: 'claude-sonnet-4-5', input, output, ...extra },
});

export interface SourceState {
  events: unknown[];
  cpuAllocated: string;
  /** Docker containers on the machine (the `mystery` compose project by default). */
  docker: boolean;
  /** Hours each day the cluster was observed (capacity and samples scale with them). */
  hours: number;
  /** What Clickland answers for a day: by default the fixture; `empty` answers with nothing. */
  clickland: 'fixture' | 'empty';
  volumes: unknown[];
}

export function fakeSources(initial: Partial<SourceState> = {}) {
  const state: SourceState = {
    events: [],
    cpuAllocated: '2.000000',
    docker: true,
    hours: 24,
    clickland: 'fixture',
    volumes: [],
    ...initial,
  };
  const rollup = (day: string) => {
    if (state.clickland === 'empty')
      return { rows: [], capacity: [], volumes: [], coverage: { sources: [], missing: [] } };
    const last = new Date(Date.parse(`${day}T00:00:00Z`) + state.hours * 3_600_000 - 60_000).toISOString();
    const cap = (24 * state.hours) / 24;
    return {
      rows: [
        {
          start: `${day}T00:00:00Z`,
          end: `${day}T00:00:00Z`,
          source: 'kubernetes',
          group: {
            'k8s.cluster.name': 'orbstack',
            'k8s.namespace.name': 'landflow-dev',
            'k8s.workload.kind': 'Deployment',
            'k8s.workload.name': 'landflow-host',
            'k8s.container.name': 'host',
          },
          cpuCoreHours: '1.000000',
          cpuAllocatedCoreHours: state.cpuAllocated,
          memoryGiBHours: '1.000000',
          memoryAllocatedGiBHours: '2.000000',
        },
        ...(state.docker
          ? [
              {
                start: `${day}T00:00:00Z`,
                end: `${day}T00:00:00Z`,
                source: 'docker',
                group: {
                  'compose.project': 'mystery',
                  'compose.service': 'thing',
                  'container.name': 'mystery-thing-1',
                },
                cpuCoreHours: '1.000000',
                cpuAllocatedCoreHours: '1.000000',
                memoryGiBHours: '0.000000',
                memoryAllocatedGiBHours: '0.000000',
              },
            ]
          : []),
      ],
      capacity: [
        {
          start: `${day}T00:00:00Z`,
          end: `${day}T00:00:00Z`,
          cluster: 'orbstack',
          node: 'orbstack',
          cpuAllocatableCoreHours: cap.toFixed(6),
          memoryAllocatableGiBHours: (cap * 2).toFixed(6),
        },
      ],
      volumes: state.volumes,
      coverage: {
        sources: [{ source: 'kubernetes', firstSample: `${day}T00:00:00Z`, lastSample: last, missingBuckets: [] }],
        missing: [],
      },
    };
  };
  const inWindow = (url: URL) => (e: unknown) =>
    (e as { at: string }).at >= url.searchParams.get('from')! &&
    (e as { at: string }).at <= url.searchParams.get('to')!;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'clickland.test') return json(rollup(JSON.parse(init!.body as string).from.slice(0, 10)));
    if (url.pathname === '/api/usage/events') return json({ events: state.events.filter(inWindow(url)) });
    if (url.pathname === '/api/usage')
      return json({ rows: [], totals: { count: state.events.filter(inWindow(url)).length, tokens: 0 } });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'ag_1', name: 'Triage lead' }] });
    if (url.pathname === '/api/workflows') return json({ workflows: [] });
    if (url.pathname === '/api/settings/ai-prices')
      return json({
        defaults: [
          { provider: 'anthropic', model: 'claude-sonnet-4-5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        ],
        overrides: [],
      });
    if (url.pathname === '/api/insights/ai-usage') return json({ models: [] });
    return new Response('not found', { status: 404 });
  };
  return { state, fetchImpl };
}
