import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuth } from '../../src/auth.js';
import { parseManifest, PluginError, publicRouteAllowed } from '../../src/plugins/manifest.js';
import { gatedApp, listen, makeRuntime, pluginPackage, type Harness, type Listening } from './helpers.js';

/**
 * A plugin's routes are behind sign-in unless it declares them public. The
 * gate in gatedApp is the same rule app.ts applies to /api, with the plugin predicate.
 */

const ID = 'media.test.public';
const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

const manifestJson = (extra: Record<string, unknown>) => ({
  id: ID,
  name: 'Public test',
  version: '1.0.0',
  description: 'x',
  author: 'x',
  category: 'tools',
  photoscout: '^1.0',
  ...extra,
});

test('parseManifest: public is an optional list of plugin route paths', () => {
  assert.equal(parseManifest(manifestJson({})).public, undefined, 'absent when not declared');
  assert.deepEqual(parseManifest(manifestJson({ public: ['/places', '/places/*', '/stations/*'] })).public, ['/places', '/places/*', '/stations/*']);
  assert.deepEqual(parseManifest(manifestJson({ public: [] })).public, undefined);
});

test('parseManifest: public routes that are not plain plugin paths are refused', () => {
  const bad: unknown[] = ['places', '/a?x=1', '/a/../b', '/a/./b', '/a b', 'https://evil.example/x', 42, ['/a']];
  for (const value of bad) {
    assert.throws(
      () => parseManifest(manifestJson({ public: [value] })),
      (err: unknown) => err instanceof PluginError,
      JSON.stringify(value),
    );
  }
  assert.throws(() => parseManifest(manifestJson({ public: '/places' })), PluginError);
});

test('publicRouteAllowed: exact paths, * as any run of characters, GET and HEAD only', () => {
  const patterns = ['/places', '/places/*', '/stations/*'];
  for (const rest of ['/places', '/places/', '/PLACES', '/places?x=1', '/places/abc/stations', '/stations/LWYfKJRw/listen', '/stations/abc']) {
    assert.equal(publicRouteAllowed(patterns, 'GET', rest), true, rest);
    assert.equal(publicRouteAllowed(patterns, 'HEAD', rest), true, `HEAD ${rest}`);
  }
  for (const rest of ['/placesX', '/secret', '/', '/admin/places', '/places/../secret', '/stations/../places', '/places/./x']) {
    assert.equal(publicRouteAllowed(patterns, 'GET', rest), false, rest);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(publicRouteAllowed(patterns, method, '/places'), false, method);
  }
  assert.equal(publicRouteAllowed(undefined, 'GET', '/places'), false, 'a plugin that declares nothing is all sign-in');
  assert.equal(publicRouteAllowed([], 'GET', '/places'), false);
});

test('needsAuth: a plugin route needs a session unless the plugin declares it public', () => {
  const declared = (id: string, method: string, rest: string) => id === ID && publicRouteAllowed(['/ping'], method, rest);
  assert.equal(needsAuth('GET', `/api/plugins/${ID}/ping`, declared), false);
  assert.equal(needsAuth('HEAD', `/api/plugins/${ID}/ping`, declared), false);
  assert.equal(needsAuth('GET', `/api/plugins/${ID}/private`, declared), true, 'undeclared');
  assert.equal(needsAuth('POST', `/api/plugins/${ID}/ping`, declared), true, 'writes always');
  assert.equal(needsAuth('GET', `/api/plugins/${ID}/ping`), true, 'with no predicate, every plugin route needs a session');
  assert.equal(needsAuth('GET', '/api/plugins-web'), false, 'the web bundle list is still open');
});

const SERVER = [
  'export default {',
  '  activate(ctx) {',
  "    ctx.router.get('/ping', (req, res) => res.json({ pong: true }));",
  "    ctx.router.post('/ping', (req, res) => res.json({ wrote: true }));",
  "    ctx.router.get('/private', (req, res) => res.json({ secret: 42 }));",
  '  },',
  '};',
].join('\n');

test('a declared public route answers a visitor; an undeclared route and any write still need a sign-in', async () => {
  const h = makeRuntime();
  harnesses.push(h);
  await h.runtime.store.installFromZip(pluginPackage({ id: ID, server: SERVER, public: ['/ping'] }), { source: 'upload' });
  await h.runtime.loadAll();
  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/ping'), true);
  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/private'), false);

  const anon = await listen(gatedApp(h.runtime, null));
  servers.push(anon);
  assert.equal((await fetch(`${anon.base}/api/plugins/${ID}/ping`)).status, 200);
  assert.equal((await fetch(`${anon.base}/api/plugins/${ID}/ping`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${anon.base}/api/plugins/${ID}/private`)).status, 401);
  assert.equal((await fetch(`${anon.base}/api/plugins/${ID}/ping`, { method: 'POST' })).status, 401);

  const member = await listen(gatedApp(h.runtime, { id: 'u-1', role: 'contributor' }));
  servers.push(member);
  assert.equal((await fetch(`${member.base}/api/plugins/${ID}/private`)).status, 200);
  assert.equal((await fetch(`${member.base}/api/plugins/${ID}/ping`, { method: 'POST' })).status, 200);
});

test('a plugin that is switched off has no public routes, and its routes ask for a sign-in', async () => {
  const h = makeRuntime();
  harnesses.push(h);
  await h.runtime.store.installFromZip(pluginPackage({ id: ID, server: SERVER, public: ['/ping'] }), { source: 'upload' });
  await h.runtime.loadAll();
  await h.runtime.setEnabled(ID, false);

  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/ping'), false);
  const anon = await listen(gatedApp(h.runtime, null));
  servers.push(anon);
  assert.equal((await fetch(`${anon.base}/api/plugins/${ID}/ping`)).status, 401);
});

test('publicRouteAllowed: a 16 KB path against a three-star pattern is refused at once', () => {
  const pattern = ['/a/*/b/*/c/*/d'];
  const long = `/a/${'x/'.repeat(8000)}nope`;
  assert.ok(long.length > 16_000);
  const started = performance.now();
  assert.equal(publicRouteAllowed(pattern, 'GET', long), false);
  assert.equal(publicRouteAllowed(pattern, 'GET', `${long}/d`), false);
  assert.ok(performance.now() - started < 100, 'the match must not backtrack');
});

test('publicRouteAllowed: a path of the longest allowed length still matches, one character longer does not', () => {
  const pattern = ['/places/*'];
  const fits = `/places/${'a'.repeat(512 - '/places/'.length)}`;
  assert.equal(publicRouteAllowed(pattern, 'GET', fits), true);
  assert.equal(publicRouteAllowed(pattern, 'GET', `${fits}b`), false);
  assert.equal(publicRouteAllowed(pattern, 'GET', `${fits}?${'q'.repeat(9000)}`), true, 'the query is not part of the path');
});

test('publicRouteAllowed agrees with a plain regular expression on many small patterns and paths', () => {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const word = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[next(alphabet.length)]).join('');
  for (let i = 0; i < 3000; i++) {
    // Patterns and paths never end in a slash, which canonical form would strip.
    const pattern = `/${word('ab*/', 1 + next(7))}`.replace(/\/+$/, '') || '/';
    const path = `/${word('ab/', 1 + next(9))}`.replace(/\/+$/, '') || '/';
    const expected = new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`).test(path);
    assert.equal(publicRouteAllowed([pattern], 'GET', path), expected, `${pattern} against ${path}`);
  }
});

test('parseManifest: a public pattern may use at most four stars', () => {
  assert.deepEqual(parseManifest(manifestJson({ public: ['/a/*/b/*/c/*/d/*/e'] })).public, ['/a/*/b/*/c/*/d/*/e']);
  assert.throws(() => parseManifest(manifestJson({ public: ['/a/*/b/*/c/*/d/*/e/*'] })), (err: unknown) => err instanceof PluginError && /at most 4/.test(err.message));
});
