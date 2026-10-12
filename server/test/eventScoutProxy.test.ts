import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { startApp } from './httpHarness.js';

interface Seen { method: string; url: string; auth?: string; cookie?: string; body: string }
const seen: Seen[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, cookie: req.headers.cookie, body });
    res.setHeader('X-Secret', 'nope');
    if (req.url?.startsWith('/api/version')) return void res.end('plain text');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, echo: body }));
  });
});
fake.listen(0, '127.0.0.1');
await once(fake, 'listening');
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => { fake.close(); return app.close(); });

const anon = app.client();
const alice = app.client();
const mod = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(mod, 'google', { id: '222', name: 'Modder' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

/** A request with the path sent exactly as written; fetch would tidy `..` and `%2e` away. */
function raw(path: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(app.base);
    const r = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { Cookie: cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject);
    r.end();
  });
}
const cookieOf = (c: { jar: Map<string, string> }) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

test('no URL set: 503', async () => {
  const r = await admin('GET', '/api/eventscout/proxy/settings');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'Events service is not set up');
});

test('only an admin gets through', async () => {
  assert.equal((await anon('GET', '/api/eventscout/proxy/settings')).status, 401);
  assert.equal((await alice('GET', '/api/eventscout/proxy/settings')).status, 403);
  const modId = (await mod('GET', '/api/auth/status')).json.user.id;
  assert.equal((await admin('PATCH', `/api/users/${modId}`, { role: 'moderator' })).json.role, 'moderator');
  assert.equal((await mod('PUT', '/api/eventscout/proxy/settings', { a: 1 })).status, 403);
  assert.equal(seen.length, 0);
});

test('admin requests are forwarded with the token, never the cookie', async () => {
  const put = await admin('PUT', '/api/settings', { eventScoutUrl: fakeUrl, eventScoutToken: 'sekrit-token' });
  assert.equal(put.status, 200);

  const got = await admin('GET', '/api/eventscout/proxy/topics?x=1');
  assert.equal(got.status, 200);
  assert.deepEqual(seen.at(-1), { method: 'GET', url: '/api/topics?x=1', auth: 'Bearer sekrit-token', cookie: undefined, body: '' });
  assert.equal(got.headers.get('x-secret'), null, 'upstream headers are dropped');

  const sent = await admin('PUT', '/api/eventscout/proxy/settings', { radius: 5 });
  assert.equal(sent.status, 200);
  assert.equal(seen.at(-1)!.method, 'PUT');
  assert.equal(seen.at(-1)!.url, '/api/settings');
  assert.equal(seen.at(-1)!.auth, 'Bearer sekrit-token');
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { radius: 5 });

  assert.equal((await admin('POST', '/api/eventscout/proxy/tasks/crawler/run', {})).status, 200);
  assert.equal(seen.at(-1)!.url, '/api/tasks/crawler/run');
  assert.deepEqual((await admin('GET', '/api/eventscout/proxy/version')).json, { text: 'plain text' });
});

test('the token is never returned', async () => {
  const r = await admin('GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('sekrit-token'));
  assert.equal(r.json.eventScoutTokenSet, true);
  assert.equal('eventScoutToken' in r.json, false);
});

test('auth, unlisted and traversal paths never reach the service', async () => {
  const before = seen.length;
  assert.equal((await admin('GET', '/api/eventscout/proxy/auth/token')).status, 404);
  assert.equal((await admin('POST', '/api/eventscout/proxy/auth/password', {})).status, 404);
  assert.equal((await admin('GET', '/api/eventscout/proxy/events')).status, 404);
  assert.equal((await admin('GET', '/api/eventscout/proxy/tasks/x/delete')).status, 404);
  const cookie = cookieOf(admin);
  for (const p of ['settings/../auth/token', '%2e%2e/auth/token', '..%2fauth/token', 'settings%2f..%2fauth', 'settings%5c..', 'a//b', 'sett%69ngs', 'settings;x']) {
    const status = await raw(`/api/eventscout/proxy/${p}`, cookie);
    assert.ok(status === 400 || status === 404, `${p} -> ${status}`);
  }
  assert.equal(seen.length, before);
});
