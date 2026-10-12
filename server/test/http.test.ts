import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

// The admin is named the only way one can be: by who a provider says they are.
const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const OWN = { Origin: 'https://photoscout.test' };

const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice Example' });
await app.signIn(bob, 'google', { id: '222', name: 'Bob' });
await app.signIn(admin, 'discord', { id: '900', name: 'Root' });

test('a visitor can read the public map and nothing that costs anything', async () => {
  const anon = app.client();
  assert.equal((await anon('GET', '/api/version')).status, 200);
  const status = await anon('GET', '/api/auth/status');
  assert.deepEqual(status.json, { authed: false, user: null, account: null, providers: ['google', 'discord'] });
  assert.equal((await anon('GET', '/api/spots')).status, 200);
  for (const closed of ['/api/weather?lat=1&lng=1', '/api/geocode?q=x', '/api/buildings?lat=1&lng=1', '/api/tasks',
    '/api/users', '/api/remotes', '/api/shares', '/api/export.geojson', '/api/export.gpx', '/api/planes', '/api/nope']) {
    assert.equal((await anon('GET', closed)).status, 401, closed);
  }
  assert.equal((await anon('POST', '/api/spots', { name: 'x', lat: 0, lng: 0 })).status, 401);
  assert.deepEqual(Object.keys((await anon('GET', '/api/settings')).json).sort(), ['areas', 'eventScoutSet', 'home', 'tfnswApiKeySet'], 'where the map opens, and no more');
  assert.equal((await anon('PUT', '/api/settings', {})).status, 401);
});

test('signing in makes an account from what the provider says, and an admin from ADMIN_IDS', async () => {
  const a = (await alice('GET', '/api/auth/status')).json;
  assert.equal(a.authed, true);
  assert.equal(a.user.username, 'AliceExample');
  assert.equal(a.user.role, 'contributor');
  assert.equal(a.account, 'google:111');
  assert.equal((await admin('GET', '/api/auth/status')).json.user.role, 'admin');
  // The same id at another provider is somebody else.
  const impostor = app.client();
  await app.signIn(impostor, 'google', { id: '900', name: 'Root' });
  const i = (await impostor('GET', '/api/auth/status')).json;
  assert.equal(i.user.role, 'contributor');
  assert.notEqual(i.user.username, 'Root', 'and the handle was taken');
  // Signing in again is the same account, not a second one.
  const again = app.client();
  await app.signIn(again, 'google', { id: '111', name: 'Alice Renamed' });
  assert.equal((await again('GET', '/api/auth/status')).json.user.id, a.user.id);
});

test('the session cookie is locked down, and so are the response headers', async () => {
  const c = app.client();
  const back = await app.signIn(c, 'google', { id: '333', name: 'Cookie' });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/');
  const session = back.headers.getSetCookie().find((l) => l.startsWith('__Host-ps_session='));
  assert.ok(session, 'session cookie set');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(session.includes(flag), flag);
  assert.ok(!/domain=/i.test(session), 'no Domain, as __Host- requires');
  const res = await c('GET', '/api/version');
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('a sign-in that was not started in this browser is not finished in it', async () => {
  const code = Buffer.from(JSON.stringify({ id: '444', name: 'Mallory' })).toString('base64url');
  const refused = async (c: ReturnType<typeof app.client>, url: string, why: string) => {
    const r = await c('GET', url);
    assert.equal(r.status, 302, why);
    assert.match(r.headers.get('location') ?? '', /^\/login\?error=/, why);
    assert.equal((await c('GET', '/api/auth/status')).json.authed, false, why);
  };
  await refused(app.client(), `/api/auth/google/callback?code=${code}&state=anything`, 'no start cookie at all');

  const wrongState = app.client();
  await wrongState('GET', '/api/auth/google/start');
  await refused(wrongState, `/api/auth/google/callback?code=${code}&state=not-the-state`, 'state does not match');

  const crossed = app.client();
  const start = await crossed('GET', '/api/auth/google/start');
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
  await refused(crossed, `/api/auth/discord/callback?code=${code}&state=${state}`, 'started with one provider, answered by another');

  const replay = app.client();
  const s2 = await replay('GET', '/api/auth/google/start');
  const st2 = new URL(s2.headers.get('location') ?? '').searchParams.get('state');
  assert.equal((await replay('GET', `/api/auth/google/callback?code=${code}&state=${st2}`)).headers.get('location'), '/');
  await replay('POST', '/api/auth/logout');
  await refused(replay, `/api/auth/google/callback?code=${code}&state=${st2}`, 'the start cookie is spent after one use');

  assert.equal((await app.client()('GET', '/api/auth/myspace/start')).status, 404);
});

test('signing out ends the session on the server, not just in the browser', async () => {
  const c = app.client();
  await app.signIn(c, 'google', { id: '555', name: 'Leaver' });
  const stolen = c.jar.get('__Host-ps_session') as string;
  assert.equal((await c('GET', '/api/shares')).status, 200);
  await c('POST', '/api/auth/logout');
  const thief = app.client();
  thief.jar.set('__Host-ps_session', stolen);
  assert.equal((await thief('GET', '/api/shares')).status, 401);
});

test('a suspended account is out at once and cannot sign back in', async () => {
  const c = app.client();
  await app.signIn(c, 'google', { id: '666', name: 'Trouble' });
  const id = (await c('GET', '/api/auth/status')).json.user.id;
  assert.equal((await c('GET', '/api/shares')).status, 200);
  assert.equal((await admin('PATCH', `/api/users/${id}`, { banned: true })).json.banned, true);
  assert.equal((await c('GET', '/api/shares')).status, 401, 'the session it already had is gone');
  const back = await app.signIn(c, 'google', { id: '666', name: 'Trouble' });
  assert.match(back.headers.get('location') ?? '', /^\/login\?error=.*suspended/);
  assert.equal((await c('GET', '/api/auth/status')).json.authed, false);
  await admin('PATCH', `/api/users/${id}`, { banned: false });
  assert.equal((await app.signIn(c, 'google', { id: '666', name: 'Trouble' })).headers.get('location'), '/');
});

test('a role change is felt on the next request, and nobody demotes or suspends themselves', async () => {
  const c = app.client();
  await app.signIn(c, 'google', { id: '777', name: 'Climber' });
  const id = (await c('GET', '/api/auth/status')).json.user.id;
  assert.equal((await c('GET', '/api/users')).status, 403);
  await admin('PATCH', `/api/users/${id}`, { role: 'admin' });
  assert.equal((await c('GET', '/api/users')).status, 200);
  await admin('PATCH', `/api/users/${id}`, { role: 'contributor' });
  assert.equal((await c('GET', '/api/users')).status, 403);
  const me = (await admin('GET', '/api/auth/status')).json.user.id;
  assert.equal((await admin('PATCH', `/api/users/${me}`, { role: 'contributor' })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${me}`, { banned: true })).status, 400);
  assert.equal((await admin('DELETE', `/api/users/${me}`)).status, 400);
  assert.equal((await admin('PATCH', '/api/users/no-such-id', { banned: true })).status, 404);
  assert.equal((await admin('PATCH', `/api/users/${id}`, { role: 'owner' })).status, 400);
});

test('private rows are their owner’s: not a visitor’s, not another account’s', async () => {
  const mine = (await alice('POST', '/api/spots', { name: 'Secret lookout', lat: -33.4, lng: 149.6 })).json;
  const open = (await alice('POST', '/api/spots', { name: 'Public lookout', lat: -33.5, lng: 149.5, visibility: 'public' })).json;
  assert.equal(mine.visibility, 'private', 'private unless said otherwise');
  const names = async (c: ReturnType<typeof app.client>) => ((await c('GET', '/api/spots')).json as { name: string }[]).map((s) => s.name).sort();
  assert.deepEqual(await names(alice), ['Public lookout', 'Secret lookout']);
  assert.deepEqual(await names(bob), ['Public lookout']);
  assert.deepEqual(await names(app.client()), ['Public lookout']);
  assert.deepEqual(await names(admin), ['Public lookout'], 'an admin’s map is not everybody’s private spots');

  for (const other of [bob, app.client()]) {
    assert.equal((await other('GET', `/api/spots/${mine.id}`)).status, 404);
    assert.equal((await other('GET', `/api/spots/${mine.id}/photos`)).status, 404);
  }
  assert.equal((await bob('PATCH', `/api/spots/${open.id}`, { name: 'Defaced' })).status, 403);
  assert.equal((await bob('DELETE', `/api/spots/${open.id}`)).status, 403);
  assert.equal((await bob('PATCH', `/api/spots/${mine.id}`, { name: 'Defaced' })).status, 403);
  assert.equal((await bob('POST', `/api/spots/${mine.id}/photos`)).status, 403);
  assert.equal((await alice('GET', `/api/spots/${open.id}`)).json.name, 'Public lookout', 'untouched');
  assert.equal((await admin('PATCH', `/api/spots/${open.id}`, { name: 'Public lookout (moderated)' })).status, 200);
});

test('running the place is for admins', async () => {
  const s = (await alice('GET', '/api/settings')).json;
  assert.deepEqual(Object.keys(s).sort(), ['areas', 'eventScoutSet', 'home', 'tfnswApiKeySet']);
  assert.equal((await alice('PUT', '/api/settings', { eventScoutUrl: 'http://10.0.0.1' })).status, 403);
  for (const [method, url] of [['GET', '/api/tasks'], ['POST', '/api/tasks/housekeeping/run'], ['GET', '/api/users'],
    ['GET', '/api/remotes'], ['POST', '/api/remotes'], ['GET', '/api/eventscout/test']] as const) {
    assert.equal((await alice(method, url, method === 'POST' ? { url: 'https://example.com/api/share/x' } : undefined)).status, 403, `${method} ${url}`);
  }
  const full = (await admin('GET', '/api/settings')).json;
  assert.ok('eventScoutUrl' in full && 'corsOrigins' in full);
  assert.ok(!('tfnswApiKey' in full), 'the key itself is never sent');
});

test('settings take the fields they know, checked, and drop the rest', async () => {
  const put = await admin('PUT', '/api/settings', {
    home: { name: 'Bathurst', lat: -33.42, lng: 149.58, radiusKm: 60 },
    areas: [{ name: 'Nowhere', lat: 400, lng: 0, radiusKm: 10 }],
    __proto__: { polluted: true }, injected: 'x', allowSignup: true,
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.home.radiusKm, 60);
  assert.deepEqual(put.json.areas, [], 'an area off the map is not stored');
  assert.ok(!('injected' in put.json) && !('allowSignup' in put.json));
});

test('a write from another site is refused even with a good session', async () => {
  const evil = await alice('POST', '/api/spots', { name: 'CSRF', lat: 0, lng: 0 }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal((await alice('POST', '/api/spots', { name: 'Fine', lat: 0, lng: 0 }, OWN)).status, 201);
  assert.equal((await alice('POST', '/api/auth/logout', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await alice('GET', '/api/auth/status')).json.authed, true, 'and was not signed out by it');
});

test('bodies are checked for shape and size before a handler sees them', async () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ name: 'x'.repeat(201), lat: 0, lng: 0 }, /name is too long/],
    [{ name: 'ok', lat: 400, lng: 0 }, /lat is out of range/],
    [{ name: 'ok', lat: 0, lng: 0, notes: 'n'.repeat(10_001) }, /notes is too long/],
    [{ name: 'ok', lat: 0, lng: 0, tags: Array(31).fill('t') }, /tags must be/],
    [{ name: 'ok', lat: 0, lng: 0, tags: [{ $gt: '' }] }, /each tag/],
    [{ name: { $ne: null }, lat: 0, lng: 0 }, /name must be text/],
  ];
  for (const [body, why] of bad) {
    const r = await alice('POST', '/api/spots', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(r.json.error, why);
  }
  assert.equal((await alice('GET', '/api/buildings?lat=91&lng=0')).status, 400);
});

test('a handle can be changed to a free, tidy one', async () => {
  const c = app.client();
  await app.signIn(c, 'google', { id: '888', name: 'Renamer' });
  assert.equal((await c('PATCH', '/api/auth/me', { username: 'New_Name1' })).json.username, 'New_Name1');
  assert.equal((await c('PATCH', '/api/auth/me', { username: 'new_name1' })).status, 200, 'its own, in another case');
  assert.equal((await c('PATCH', '/api/auth/me', { username: 'aliceexample' })).status, 409, 'taken, whatever the case');
  for (const bad of ['ab', 'has space', '<script>', 'x'.repeat(25), '', 42]) {
    assert.equal((await c('PATCH', '/api/auth/me', { username: bad })).status, 400, String(bad));
  }
  assert.equal((await app.client()('PATCH', '/api/auth/me', { username: 'Nobody' })).status, 401);
});

test('share links are counted, and what the caller posts is not stored', async () => {
  const c = app.client();
  await app.signIn(c, 'google', { id: '999', name: 'Sharer' });
  for (let i = 0; i < 20; i++) assert.equal((await c('POST', '/api/shares', { junk: 'x'.repeat(1000) })).status, 201);
  assert.equal((await c('POST', '/api/shares', {})).status, 400);
  const rows = (await c('GET', '/api/shares')).json as { filter: string; token: string }[];
  assert.ok(rows.every((r) => r.filter === '{}'));
  await c('DELETE', `/api/shares/${rows[0].token}`);
  assert.equal((await c('POST', '/api/shares', {})).status, 201, 'revoking one makes room');
  assert.equal((await bob('DELETE', `/api/shares/${rows[1].token}`)).status, 403);
});
