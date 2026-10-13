import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const admin = app.client();
const mod = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
await app.signIn(mod, 'google', { id: '701', name: 'Moddy' });
const modId = (await mod('GET', '/api/auth/status')).json.user.id;
await admin('PATCH', `/api/users/${modId}`, { role: 'moderator' });

/** What the admin screens call: places and density, conditions, and edit, merge, archive. */
const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/events-admin/photo'],
  ['GET', '/api/events-admin/density/areas'],
  ['GET', '/api/events-admin/density/anywhere/venues'],
  ['GET', '/api/events-admin/density/anywhere/history?venue=x'],
  ['GET', '/api/events-admin/density/anywhere'],
  ['PATCH', '/api/events-admin/events/some-group', { title: 'x' }],
  ['POST', '/api/events-admin/merge', { groups: ['a', 'b'] }],
  ['POST', '/api/events-admin/unmerge/some-group', {}],
  ['POST', '/api/events-admin/events/some-group/parent', { id: 1 }],
  ['POST', '/api/events-admin/archive', {}],
];

test('the events admin routes are closed to visitors (401) and to everyone but an admin (403)', async () => {
  for (const [method, url, body] of ROUTES) {
    assert.equal((await anon(method, url, body)).status, 401, `anonymous ${method} ${url}`);
    assert.equal((await alice(method, url, body)).status, 403, `contributor ${method} ${url}`);
    assert.equal((await mod(method, url, body)).status, 403, `moderator ${method} ${url}`);
  }
});

test('an admin reaches them: the answers come from the engine, not the gate', async () => {
  assert.equal((await admin('GET', '/api/events-admin/density/areas')).status, 200);
  assert.equal((await admin('PATCH', '/api/events-admin/events/no-such-group', { title: 'x' })).status, 404);
  assert.equal((await admin('POST', '/api/events-admin/merge', { groups: ['only-one'] })).status, 400);
  assert.equal((await admin('GET', '/api/events-admin/density/nowhere')).status, 404);
});
