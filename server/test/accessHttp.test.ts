import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

// PUBLIC_READS is left unset (the harness would otherwise turn it on), so this app runs with the real default.
const app = await startApp({ PUBLIC_READS: '', ADMIN_IDS: 'google:admin1' });
after(() => app.close());

const anon = app.client();
const member = app.client();
const admin = app.client();
await app.signIn(member, 'google', { id: 'm1', name: 'Member' });
await app.signIn(admin, 'google', { id: 'admin1', name: 'Admin' });

const box = 'minLng=151.1&minLat=-33.95&maxLng=151.3&maxLat=-33.8';
/** What a visitor may read when public reads are on, and what the gate refuses when they are not. */
const MAP_READS = ['/api/places', '/api/spots', '/api/routes', '/api/settings', '/api/events', '/api/feed', '/api/plugins-web', `/api/waze/heatmap?${box}`, `/api/waze/alerts?${box}`];

/** Put the environment back however a test leaves it. */
function withEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PUBLIC_READS;
  process.env.PUBLIC_READS = value;
  return fn().finally(() => { process.env.PUBLIC_READS = before ?? ''; });
}

test('a fresh instance is private: sign-in and the version answer a visitor, the public map does not', async () => {
  const status = await anon('GET', '/api/auth/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.authed, false);
  assert.ok(status.json.providers.includes('google'), 'a visitor can see how to sign in');
  assert.equal((await anon('GET', '/api/version')).status, 200);
  assert.equal((await anon('GET', '/api/auth/google/start')).status, 302, 'the sign-in redirect is open');
  // A share link and a calendar link are their own credential: the route answers, it does not ask for a session.
  assert.notEqual((await anon('GET', '/api/share/nosuchtoken')).status, 401);
  assert.notEqual((await anon('GET', '/api/calendar/nosuchtoken')).status, 401);

  for (const path of MAP_READS) {
    const res = await anon('GET', path);
    assert.equal(res.status, 401, path);
    assert.equal(res.json.error, 'Sign in required', path);
  }
  assert.equal((await anon('HEAD', '/api/places')).status, 401);

  for (const path of MAP_READS) assert.notEqual((await member('GET', path)).status, 401, `signed in: ${path}`);
  assert.equal((await member('GET', '/api/places')).status, 200);
});

test('the access setting is for admins: a visitor is refused sign-in, a member is refused as not an admin', async () => {
  assert.equal((await anon('GET', '/api/settings/access')).status, 401);
  assert.equal((await anon('PUT', '/api/settings/access', { publicReads: true })).status, 401);
  assert.equal((await member('GET', '/api/settings/access')).status, 403);
  assert.equal((await member('PUT', '/api/settings/access', { publicReads: true })).status, 403);
  const view = await admin('GET', '/api/settings/access');
  assert.equal(view.status, 200);
  assert.deepEqual(view.json, { publicReads: false, source: 'default' });
  // The refused attempts changed nothing.
  assert.equal((await anon('GET', '/api/places')).status, 401);
});

test('an admin can open the public map and close it again, and bad input changes nothing', async () => {
  const open = await admin('PUT', '/api/settings/access', { publicReads: true });
  assert.equal(open.status, 200);
  assert.deepEqual(open.json, { publicReads: true, source: 'stored' });
  assert.deepEqual((await admin('GET', '/api/settings/access')).json, { publicReads: true, source: 'stored' });

  // Not every one of these has data to answer with (the Waze alerts need the bridge), but none asks for a sign-in.
  for (const path of MAP_READS) assert.notEqual((await anon('GET', path)).status, 401, `public: ${path}`);
  for (const path of ['/api/places', '/api/spots', '/api/routes', '/api/settings', `/api/waze/heatmap?${box}`]) {
    assert.equal((await anon('GET', path)).status, 200, `public: ${path}`);
  }
  // What was never public stays behind sign-in, and so does the setting itself.
  for (const path of ['/api/users', '/api/geocode?q=sydney', '/api/settings/access', '/api/tasks', '/api/chat']) {
    assert.equal((await anon('GET', path)).status, 401, `still closed: ${path}`);
  }
  assert.equal((await anon('POST', '/api/spots', { name: 'x', lat: 0, lng: 0 })).status, 401);

  for (const body of [{ publicReads: 'false' }, { publicReads: 0 }, { publicReads: null }, {}, undefined]) {
    assert.equal((await admin('PUT', '/api/settings/access', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await admin('GET', '/api/settings/access')).json, { publicReads: true, source: 'stored' }, 'a refused save leaves the setting alone');
  assert.equal((await member('PUT', '/api/settings/access', { publicReads: false })).status, 403, 'a member cannot close it either');

  const close = await admin('PUT', '/api/settings/access', { publicReads: false });
  assert.deepEqual(close.json, { publicReads: false, source: 'stored' });
  for (const path of MAP_READS) assert.equal((await anon('GET', path)).status, 401, `private again: ${path}`);
});

test('PUBLIC_READS in the environment wins, and a save is refused while it is set', async () => {
  // Stored: private. The environment says public.
  await withEnv('1', async () => {
    assert.deepEqual((await admin('GET', '/api/settings/access')).json, { publicReads: true, source: 'env' });
    assert.equal((await anon('GET', '/api/places')).status, 200);
    const refused = await admin('PUT', '/api/settings/access', { publicReads: false });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /PUBLIC_READS/);
  });
  assert.equal((await anon('GET', '/api/places')).status, 401, 'taking the variable away brings back the stored choice');

  // Stored: public. The environment says private.
  assert.equal((await admin('PUT', '/api/settings/access', { publicReads: true })).status, 200);
  assert.equal((await anon('GET', '/api/places')).status, 200);
  await withEnv('0', async () => {
    assert.deepEqual((await admin('GET', '/api/settings/access')).json, { publicReads: false, source: 'env' });
    assert.equal((await anon('GET', '/api/places')).status, 401);
    assert.equal((await admin('PUT', '/api/settings/access', { publicReads: true })).status, 409);
  });
  await withEnv('yes', async () => {
    assert.equal((await anon('GET', '/api/places')).status, 401, 'a value that is not 1 or true never opens the instance');
  });
  assert.equal((await admin('PUT', '/api/settings/access', { publicReads: false })).status, 200);
});

test('CORS follows the same mode as the gate: another origin is offered the public map only when a visitor may read it', async () => {
  const origin = 'https://map.example';
  assert.equal((await admin('PUT', '/api/settings', { corsOrigins: [origin] })).status, 200);
  const acao = (r: { headers: Headers }) => r.headers.get('access-control-allow-origin');

  // Private: the version and sign-in status can be read from the origin; the map cannot.
  assert.equal(acao(await anon('GET', '/api/version', undefined, { Origin: origin })), origin);
  assert.equal(acao(await anon('GET', '/api/auth/status', undefined, { Origin: origin })), origin);
  const closed = await anon('GET', '/api/places', undefined, { Origin: origin });
  assert.equal(closed.status, 401);
  assert.equal(acao(closed), null);
  assert.equal((await anon('OPTIONS', '/api/places', undefined, { Origin: origin, 'Access-Control-Request-Method': 'GET' })).headers.get('access-control-allow-origin'), null);

  await withEnv('1', async () => {
    const open = await anon('GET', '/api/places', undefined, { Origin: origin });
    assert.equal(open.status, 200);
    assert.equal(acao(open), origin);
    const pre = await anon('OPTIONS', '/api/places', undefined, { Origin: origin, 'Access-Control-Request-Method': 'GET' });
    assert.equal(pre.status, 204);
    assert.equal(acao(pre), origin);
  });
  assert.equal((await admin('PUT', '/api/settings', { corsOrigins: [] })).status, 200);
});
