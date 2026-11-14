/**
 * SCIM 2.0 for Landbright's push, against Postgres (LANDLEDGER_INTEGRATION=db): Clickland's conformance-style suite
 * (clickland apps/api/test/identity.integration.test.ts) in the forms Landbright sends, on Landledger's groups and
 * roles, plus what is Landledger's own: a DELETE deactivates and hides a person (decisions name them) and a second push
 * brings the same person back. People sign in through a fake Landbright.
 */
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSql, type Sql } from '../src/db.js';
import { SCHEMAS } from '../src/scim.js';
import { seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { testConfig } from './fakes.js';

const BOOTSTRAP = 'll_bootstrap_test_key_0000000000000000';
const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@landbright.test`;

describe.skipIf(!integrationEnabled('db'))('SCIM 2.0 and sign-in (Landbright push)', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  let token = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.appUrl);
    fake = await fakeLandbright();
    const fetchImpl: typeof fetch = (input, init) => fake.fetchImpl(input, init);
    services = createServices(
      testConfig({
        postgresUrl: db.appUrl,
        devAuth: false,
        oidc: oidcConfig,
        oidcProblem: null,
        bootstrapKey: BOOTSTRAP,
      }),
      sql,
      fetchImpl,
    );
    app = await buildApp(services);
    await seed(sql);
    const minted = await services.scimTokens.create(`test ${run}`, { actor: 'test', actorKind: 'system' });
    token = minted.token;
    expect(token).toMatch(/^lls_[\w-]{40}$/);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const scim = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    type = 'application/scim+json',
    bearer = token,
  ) =>
    app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(payload === undefined ? {} : { 'content-type': type }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const patch = (Operations: unknown[]) => ({ schemas: [SCHEMAS.patch], Operations });

  /** What Landbright sends for a person. */
  const userBody = (who: string, sub: string, given: string, family: string) => ({
    schemas: [SCHEMAS.user],
    userName: email(who),
    externalId: sub,
    displayName: `${given} ${family}`,
    name: { givenName: given, familyName: family, formatted: `${given} ${family}` },
    emails: [{ value: email(who), type: 'work', primary: true }],
    active: true,
  });

  /** POST /Groups; on 409, GET by displayName (Landbright's adoption). */
  async function ensureGroup(displayName: string, members: string[] = []): Promise<string> {
    const res = await scim('POST', '/Groups', {
      schemas: [SCHEMAS.group],
      displayName,
      externalId: `test-${run}-${displayName}`,
      members: members.map((value) => ({ value })),
    });
    if (res.statusCode === 201) return res.json().id;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '409', scimType: 'uniqueness' });
    const found = await scim('GET', `/Groups?filter=${encodeURIComponent(`displayName eq "${displayName}"`)}`);
    const id = found.json().Resources[0].id as string;
    if (members.length)
      await scim(
        'PATCH',
        `/Groups/${id}`,
        patch([{ op: 'add', path: 'members', value: members.map((value) => ({ value })) }]),
      );
    return id;
  }

  /** A person signs in through the fake Landbright the way a browser does: the session cookie, or the error. */
  async function signIn(person: Person): Promise<{ cookie?: string; location: string }> {
    const login = await app.inject({ url: '/api/auth/login?returnTo=/requests' });
    expect(login.statusCode).toBe(302);
    const state = login.cookies.find((c) => c.name === 'll_login')!.value;
    const q = fake.authorize(login.headers.location as string, person);
    const cb = await app.inject({
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      cookies: { ll_login: state },
    });
    expect(cb.statusCode).toBe(302);
    return {
      cookie: cb.cookies.find((c) => c.name === 'll_session' && c.value)?.value,
      location: cb.headers.location as string,
    };
  }
  const me = (cookie: string) => app.inject({ url: '/api/auth/me', cookies: { ll_session: cookie } });
  const roles = async (cookie: string) => (await me(cookie)).json().user.roles as string[];
  const as = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { ll_session: cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it('answers the discovery endpoints, and only to a SCIM token', async () => {
    const spc = await scim('GET', '/ServiceProviderConfig');
    expect(spc.statusCode).toBe(200);
    expect(spc.headers['content-type']).toMatch(/^application\/scim\+json/);
    expect(spc.json()).toMatchObject({
      patch: { supported: true },
      filter: { supported: true },
      bulk: { supported: false },
    });
    const types = (await scim('GET', '/ResourceTypes')).json();
    expect(types.Resources.map((t: { id: string }) => t.id)).toEqual(['User', 'Group']);
    expect((await scim('GET', '/ResourceTypes/User')).json().endpoint).toBe('/Users');
    const schemas = (await scim('GET', '/Schemas')).json();
    expect(schemas.totalResults).toBe(2);
    expect((await scim('GET', `/Schemas/${SCHEMAS.group}`)).json().name).toBe('Group');
    const missing = await scim('GET', '/Nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '404' });
    // An API key, even the bootstrap admin key, is not a SCIM token; nor is a revoked token.
    const key = await scim('GET', '/Users', undefined, undefined, BOOTSTRAP);
    expect(key.statusCode).toBe(401);
    expect(key.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '401' });
    expect((await app.inject({ url: '/scim/v2/Users' })).statusCode).toBe(401);
    const spare = await services.scimTokens.create('spare', { actor: 'test', actorKind: 'system' });
    expect((await scim('GET', '/Users', undefined, undefined, spare.token)).statusCode).toBe(200);
    const { DEV_PRINCIPAL } = await import('../src/principal.js');
    await services.scimTokens.revoke(spare.id, DEV_PRINCIPAL);
    expect((await scim('GET', '/Users', undefined, undefined, spare.token)).statusCode).toBe(401);
  });

  it('creates a user (application/json too), then 409, then filter, then adopt with a pathless PATCH', async () => {
    const created = await scim(
      'POST',
      '/Users',
      userBody('maya', `sub-maya-${run}`, 'Maya', 'Cohen'),
      'application/json',
    );
    expect(created.statusCode).toBe(201);
    const user = created.json();
    expect(created.headers.location).toBe(`http://localhost:80/scim/v2/Users/${user.id}`);
    expect(user).toMatchObject({
      schemas: [SCHEMAS.user],
      userName: email('maya'),
      externalId: `sub-maya-${run}`,
      displayName: 'Maya Cohen',
      name: { givenName: 'Maya', familyName: 'Cohen', formatted: 'Maya Cohen' },
      emails: [{ value: email('maya'), type: 'work', primary: true }],
      active: true,
      groups: [],
      meta: { resourceType: 'User' },
    });

    const again = await scim('POST', '/Users', userBody('maya', `sub-maya-${run}`, 'Maya', 'Cohen'));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      schemas: [SCHEMAS.error],
      status: '409',
      scimType: 'uniqueness',
      detail: expect.any(String),
    });

    const found = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent(`userName eq "${email('maya').toUpperCase()}"`)}`,
    );
    expect(found.json()).toMatchObject({ schemas: [SCHEMAS.list], totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect(found.json().Resources[0].id).toBe(user.id);

    const adopted = await scim(
      'PATCH',
      `/Users/${user.id}`,
      patch([
        {
          op: 'replace',
          value: {
            userName: email('maya'),
            displayName: 'Maya C.',
            externalId: `sub-maya2-${run}`,
            name: { givenName: 'Maya', familyName: 'C.' },
          },
        },
      ]),
    );
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toMatchObject({
      displayName: 'Maya C.',
      externalId: `sub-maya2-${run}`,
      name: { familyName: 'C.' },
    });
    for (const filter of [`externalId eq "sub-maya2-${run}"`, 'displayName eq "maya c."']) {
      const byFilter = await scim('GET', `/Users?filter=${encodeURIComponent(filter)}`);
      expect(byFilter.json().Resources.map((u: { id: string }) => u.id)).toContain(user.id);
    }
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('title eq "x"')}`)).json()).toMatchObject({
      status: '400',
      scimType: 'invalidFilter',
    });
    const gone = await scim('PATCH', '/Users/usr_missing', patch([{ op: 'replace', path: 'active', value: false }]));
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '404' });
    // System users (seed, cli) are not people: never listed.
    const all = (await scim('GET', '/Users?count=500')).json();
    expect(all.Resources.map((u: { userName: string }) => u.userName)).not.toContain('seed');
    // Every change is in the audit log, by the token's name.
    const [entry] =
      await sql`SELECT actor, actor_kind FROM audit_log WHERE action = 'scim.user_created' AND subject_id = ${user.id}`;
    expect(entry).toMatchObject({ actor: `scim:test ${run}`, actor_kind: 'key' });
  });

  it('signs a person in just in time, then SCIM adopts them by email and takes over their profile', async () => {
    const yoav: Person = {
      sub: `sub-yoav-${run}`,
      email: email('yoav'),
      name: 'Yoav Ben David',
      roles: ['Landledger Auditors', 'Everyone'],
    };
    const { cookie, location } = await signIn(yoav);
    expect(location).toBe('/requests');
    const who = (await me(cookie!)).json();
    expect(who).toMatchObject({
      kind: 'person',
      authMode: 'oidc',
      user: { email: email('yoav'), name: 'Yoav Ben David', roles: ['auditor'] },
    });
    expect(who.scopes).toEqual(['read']);

    expect((await scim('POST', '/Users', userBody('yoav', yoav.sub, 'Yoav', 'Ben David'))).statusCode).toBe(409);
    const id = (await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${email('yoav')}"`)}`)).json()
      .Resources[0].id;
    expect(id).toBe(who.user.id);
    await scim(
      'PATCH',
      `/Users/${id}`,
      patch([{ op: 'replace', value: { displayName: 'Yoav B.D.', externalId: yoav.sub } }]),
    );
    const second = await signIn({ ...yoav, name: 'Someone Else' });
    expect((await me(second.cookie!)).json().user.name).toBe('Yoav B.D.');
  });

  it('lets a person SCIM pushed first sign in, taking the pushed account by email', async () => {
    const pushed = (
      await scim('POST', '/Users', { ...userBody('omer', 'x', 'Omer', 'Katz'), externalId: undefined })
    ).json();
    expect(pushed.externalId).toBeUndefined();
    const { cookie } = await signIn({
      sub: `sub-omer-${run}`,
      email: email('omer'),
      name: 'Omer',
      roles: ['Engineering'],
    });
    expect((await me(cookie!)).json().user.id).toBe(pushed.id);
    expect((await scim('GET', `/Users/${pushed.id}`)).json().externalId).toBe(`sub-omer-${run}`);
  });

  it('ends every session of a deactivated person at once, and refuses their sign-in until reactivated', async () => {
    const eden: Person = { sub: `sub-eden-${run}`, email: email('eden'), name: 'Eden Tzur', roles: ['Engineering'] };
    const created = (await scim('POST', '/Users', userBody('eden', eden.sub, 'Eden', 'Tzur'))).json();
    const a = await signIn(eden);
    const b = await signIn(eden);
    expect((await as(a.cookie!, 'GET', '/api/requests')).statusCode).toBe(200);
    const [{ n }] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${created.id} AND revoked_at IS NULL`;
    expect(n).toBe(2);

    const off = await scim('PATCH', `/Users/${created.id}`, patch([{ op: 'replace', path: 'active', value: false }]));
    expect(off.json().active).toBe(false);
    const [{ left }] = await sql<
      { left: number }[]
    >`SELECT count(*)::int AS left FROM sessions WHERE user_id = ${created.id} AND revoked_at IS NULL`;
    expect(left).toBe(0);
    for (const c of [a.cookie!, b.cookie!]) {
      expect((await as(c, 'GET', '/api/requests')).statusCode).toBe(401);
      expect((await me(c)).statusCode).toBe(401);
    }
    expect((await signIn(eden)).location).toBe('/requests?signin_error=inactive');

    await scim('PATCH', `/Users/${created.id}`, patch([{ op: 'Replace', path: 'active', value: 'True' }]));
    const back = await signIn(eden);
    expect(await roles(back.cookie!)).toEqual(['engineer']);
  });

  it('changes the role on the next request when SCIM changes group membership (SCIM wins over the claim)', async () => {
    const shira: Person = {
      sub: `sub-shira-${run}`,
      email: email('shira'),
      name: 'Shira Navon',
      roles: ['Landledger Auditors'],
    };
    const user = (await scim('POST', '/Users', userBody('shira', shira.sub, 'Shira', 'Navon'))).json();
    const { cookie } = await signIn(shira);
    expect(await roles(cookie!)).toEqual(['auditor']); // the claim, until SCIM sets groups
    expect((await as(cookie!, 'POST', '/api/requests', {})).statusCode).toBe(403);

    const engineers = await ensureGroup('Engineering', [user.id]);
    expect(await roles(cookie!)).toEqual(['engineer']);
    expect((await as(cookie!, 'POST', '/api/requests', {})).statusCode).toBe(400); // allowed; the body is wrong
    expect((await as(cookie!, 'GET', '/api/keys')).statusCode).toBe(403);
    const shown = (await scim('GET', `/Groups/${engineers}`)).json();
    expect(shown.members.map((m: { value: string }) => m.value)).toContain(user.id);
    expect((await scim('GET', `/Users/${user.id}`)).json().groups).toEqual([
      expect.objectContaining({ value: engineers, display: 'Engineering' }),
    ]);

    const controllers = await ensureGroup('Finance Controllers');
    await scim('PATCH', `/Groups/${controllers}`, patch([{ op: 'add', path: 'members', value: [{ value: user.id }] }]));
    expect((await roles(cookie!)).sort()).toEqual(['controller', 'engineer']);
    expect((await as(cookie!, 'GET', '/api/keys')).statusCode).toBe(200);

    for (const g of [controllers, engineers])
      await scim('PATCH', `/Groups/${g}`, patch([{ op: 'remove', path: `members[value eq "${user.id}"]` }]));
    // SCIM has spoken: no Landledger group now, even though the claim still says auditor.
    const refused = await me(cookie!);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.details.reason).toBe('no_role');
    expect((await signIn(shira)).location).toBe('/requests?signin_error=no_role');
  });

  it('accepts the groups replace form on a user (names), and member add/remove and rename on a group', async () => {
    const tal = (await scim('POST', '/Users', userBody('tal', `sub-tal-${run}`, 'Tal', 'Levi'))).json();
    const res = await scim(
      'PATCH',
      `/Users/${tal.id}`,
      patch([
        {
          op: 'replace',
          path: 'groups',
          value: [
            { value: 'Landledger Auditors', display: 'Landledger Auditors' },
            { value: `Team ${run}`, display: `Team ${run}` },
          ],
        },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .groups.map((g: { display: string }) => g.display)
        .sort(),
    ).toEqual(['Landledger Auditors', `Team ${run}`]);
    const { cookie } = await signIn({
      sub: `sub-tal-${run}`,
      email: email('tal'),
      name: 'Tal',
      roles: ['Finance CFO'],
    });
    expect(await roles(cookie!)).toEqual(['auditor']);

    const again = await scim(
      'PATCH',
      `/Users/${tal.id}`,
      patch([{ op: 'replace', path: 'groups', value: [{ value: `Team ${run}`, display: `Team ${run}` }] }]),
    );
    expect(again.json().groups.map((g: { display: string }) => g.display)).toEqual([`Team ${run}`]);

    const team = (await scim('GET', `/Groups?filter=${encodeURIComponent(`displayName eq "Team ${run}"`)}`)).json()
      .Resources[0];
    const renamed = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'replace', path: 'displayName', value: `Renamed ${run}` }]),
    );
    expect(renamed.json()).toMatchObject({
      displayName: `Renamed ${run}`,
      members: [expect.objectContaining({ value: tal.id })],
    });
    const pathless = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'replace', value: { displayName: `Team ${run}` } }]),
    );
    expect(pathless.json().displayName).toBe(`Team ${run}`);
    const emptied = await scim('PATCH', `/Groups/${team.id}`, patch([{ op: 'remove', path: 'members' }]));
    expect(emptied.json().members).toEqual([]);
    const unknown = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'add', path: 'members', value: [{ value: 'usr_nobody' }] }]),
    );
    expect(unknown.json()).toMatchObject({ status: '400', scimType: 'invalidValue' });
    const noMembers = await scim('GET', `/Groups/${team.id}?excludedAttributes=members`);
    expect(noMembers.json().members).toBeUndefined();
  });

  it('deletes a group, and its members lose what it gave them', async () => {
    const yael = (await scim('POST', '/Users', userBody('yael', `sub-yael-${run}`, 'Yael', 'Test'))).json();
    const group = await ensureGroup(`Doomed ${run}`, [yael.id]);
    expect((await scim('GET', `/Users/${yael.id}`)).json().groups).toHaveLength(1);
    expect((await scim('POST', '/Groups', { displayName: `doomed ${run}` })).statusCode).toBe(409);
    expect((await scim('DELETE', `/Groups/${group}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${group}`)).statusCode).toBe(404);
    expect((await scim('DELETE', `/Groups/${group}`)).statusCode).toBe(404);
    expect((await scim('GET', `/Users/${yael.id}`)).json().groups).toEqual([]);
  });

  it('deletes a user by deactivating and hiding them (their decisions keep naming them); a new push brings them back', async () => {
    const lior: Person = { sub: `sub-lior-${run}`, email: email('lior'), name: 'Lior Azulay', roles: ['Engineering'] };
    const user = (await scim('POST', '/Users', userBody('lior', lior.sub, 'Lior', 'Azulay'))).json();
    const { cookie } = await signIn(lior);
    expect((await scim('DELETE', `/Users/${user.id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${user.id}`)).statusCode).toBe(404);
    expect((await me(cookie!)).statusCode).toBe(401);
    const [row] = await sql`SELECT id, active, deleted_at FROM users WHERE id = ${user.id}`;
    expect(row).toMatchObject({ id: user.id, active: false });
    expect(row!.deleted_at).not.toBeNull();
    expect((await signIn(lior)).location).toBe('/requests?signin_error=inactive');
    const back = await scim('POST', '/Users', userBody('lior', lior.sub, 'Lior', 'Azulay'));
    expect(back.statusCode).toBe(201);
    expect(back.json()).toMatchObject({ id: user.id, active: true, groups: [] });
    // SCIM set their groups (none) when it deleted them: the groups come back with the next push.
    expect((await signIn(lior)).location).toBe('/requests?signin_error=no_role');
    await ensureGroup('Engineering', [user.id]);
    expect(await roles((await signIn(lior)).cookie!)).toEqual(['engineer']);
  });

  it('refuses someone in no Landledger group without creating them, and keeps keys working beside sessions', async () => {
    const outsider: Person = {
      sub: `sub-out-${run}`,
      email: email('outsider'),
      name: 'Out Sider',
      roles: ['Everyone'],
    };
    expect((await signIn(outsider)).location).toBe('/requests?signin_error=no_role');
    const [row] = await sql`SELECT id FROM users WHERE subject = ${outsider.sub}`;
    expect(row).toBeUndefined();
    const viewer = await signIn({
      sub: `sub-v-${run}`,
      email: email('viewer'),
      name: 'V',
      roles: ['Landledger Auditors'],
    });
    const key = await app.inject({
      url: '/api/keys',
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
      cookies: { ll_session: viewer.cookie! },
    });
    expect(key.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/requests' })).statusCode).toBe(401);
    // The SCIM token is no API key either.
    expect((await app.inject({ url: '/api/requests', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(
      401,
    );
    void ISSUER;
  });
});
