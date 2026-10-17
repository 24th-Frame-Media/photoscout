import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../httpHarness.js';

/** The real app: the distribution routes are admin-only, and the registry list is stored in the database. */

const app = await startApp({ ADMIN_IDS: 'google:admin1' });
after(() => app.close());

const anon = app.client();
const member = app.client();
const admin = app.client();
await app.signIn(member, 'google', { id: 'm1', name: 'Member' });
await app.signIn(admin, 'google', { id: 'admin1', name: 'Admin' });

const BASE = '/api/admin/plugins';
const ROUTES: [string, string, unknown][] = [
  ['GET', '/registries', undefined],
  ['POST', '/registries', { url: 'https://93.184.216.34/registry.json' }],
  ['DELETE', '/registries', { url: 'https://93.184.216.34/registry.json' }],
  ['GET', '/registry', undefined],
  ['POST', '/preview-remote', { registryUrl: 'https://x.example/r.json', id: 'a.b' }],
  ['POST', '/install-remote', { registryUrl: 'https://x.example/r.json', id: 'a.b' }],
];

test('every distribution route is admin-only: 401 anonymous, 403 member', async () => {
  for (const [method, path, body] of ROUTES) {
    assert.equal((await anon(method, BASE + path, body)).status, 401, `anon ${method} ${path}`);
    assert.equal((await member(method, BASE + path, body)).status, 403, `member ${method} ${path}`);
  }
});

test('an admin manages registries; the list persists in the database and the default cannot be removed', async () => {
  const list = await admin('GET', `${BASE}/registries`);
  assert.equal(list.status, 200);
  assert.equal(list.json.registries[0].isDefault, true);
  const defaultUrl = list.json.registries[0].url as string;

  const added = await admin('POST', `${BASE}/registries`, { url: 'https://93.184.216.34/registry.json' });
  assert.equal(added.status, 200);
  assert.equal(added.json.registries.length, 2);
  assert.equal((await admin('GET', `${BASE}/registries`)).json.registries.length, 2);

  assert.equal((await admin('POST', `${BASE}/registries`, { url: 'https://127.0.0.1/r.json' })).status, 400);
  assert.equal((await admin('DELETE', `${BASE}/registries`, { url: defaultUrl })).status, 400);
  assert.equal((await admin('DELETE', `${BASE}/registries`, { url: 'https://93.184.216.34/registry.json' })).status, 200);
  assert.equal((await admin('GET', `${BASE}/registries`)).json.registries.length, 1);

  // Not a configured registry: refused before any fetch.
  const nope = await admin('GET', `${BASE}/registry?url=${encodeURIComponent('https://evil.example/r.json')}`);
  assert.equal(nope.status, 400);
  assert.match(nope.json.error, /not configured/);
  assert.equal((await admin('POST', `${BASE}/install-remote`, { registryUrl: 'https://evil.example/r.json', id: 'a.b' })).status, 400);
});
