import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupFunction } from 'node:net';
import { publicLookup } from '../../src/events/nethost.js';
import { parseManifest, parseNetworkDetail, PluginError } from '../../src/plugins/manifest.js';
import { createPluginFetch, declaredHosts, type Send } from '../../src/plugins/netscope.js';
import { gatedApp, listen, makeRuntime, pluginPackage, type Harness, type Listening } from './helpers.js';

/**
 * A plugin may declare one host under a `network` permission and reach it even
 * when it is private or loopback. Everything else stays public-only. No real
 * network is used: requests go to a scripted `send`, and every host here is an
 * IP literal so no DNS lookup happens.
 */

const net = (detail: string) => ({ permissions: [{ kind: 'network' as const, detail }] });

interface Sent {
  url: string;
  lookup: LookupFunction;
  headers: Headers;
}

/** A transport that answers from a table (a function runs per request) and records what was asked. */
function scripted(table: Record<string, () => Response>) {
  const sent: Sent[] = [];
  const send: Send = async (url, init, lookup) => {
    sent.push({ url, lookup, headers: new Headers(init.headers) });
    const answer = table[url];
    if (!answer) throw new Error(`unexpected request: ${url}`);
    return answer();
  };
  return { send, sent };
}

const ok = (body = 'ok') => () => new Response(body, { status: 200 });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
const PUBLIC_LOOKUP = publicLookup as LookupFunction;

test('a declared host:port is reachable, and is dialled through a lookup that allows private answers', async () => {
  const { send, sent } = scripted({ 'http://127.0.0.1:18199/x': ok('hi') });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  const res = await fetchIt('http://127.0.0.1:18199/x');
  assert.equal(await res.text(), 'hi');
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].lookup, PUBLIC_LOOKUP);
});

test('only the declared port: another port on the same host is refused, and nothing is sent', async () => {
  const { send, sent } = scripted({ 'http://127.0.0.1:9999/x': ok() });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  await assert.rejects(fetchIt('http://127.0.0.1:9999/x'), /private address/);
  assert.equal(sent.length, 0);
});

test('only the declared host: another private host is refused, including a neighbour address', async () => {
  const { send, sent } = scripted({ 'http://10.0.0.5/x': ok(), 'http://127.0.0.2:18199/x': ok(), 'http://169.254.169.254/latest': ok() });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  await assert.rejects(fetchIt('http://10.0.0.5/x'), /private address/);
  await assert.rejects(fetchIt('http://127.0.0.2:18199/x'), /private address/);
  await assert.rejects(fetchIt('http://169.254.169.254/latest'), /private address/);
  assert.equal(sent.length, 0);
});

test('a declaration without a port covers every port of that host; the default port counts as 80 and 443', async () => {
  const { send, sent } = scripted({ 'http://127.0.0.1:1234/': ok(), 'http://127.0.0.1:5678/': ok() });
  const any = createPluginFetch(net('127.0.0.1'), { send });
  await any('http://127.0.0.1:1234/');
  await any('http://127.0.0.1:5678/');
  assert.equal(sent.length, 2);

  const dflt = scripted({ 'http://127.0.0.1/': ok(), 'https://127.0.0.1/': ok() });
  const only80 = createPluginFetch(net('127.0.0.1:80'), { send: dflt.send });
  await only80('http://127.0.0.1/');
  await assert.rejects(only80('https://127.0.0.1/'), /private address/);
});

test('localhost and IPv6 literals work when declared exactly, and a numeric spelling of loopback is the same host', async () => {
  const a = scripted({ 'http://localhost:11434/api': ok() });
  await createPluginFetch(net('localhost:11434'), { send: a.send })('http://localhost:11434/api');
  assert.equal(a.sent.length, 1);

  const b = scripted({ 'http://[::1]:8080/': ok() });
  const v6 = createPluginFetch(net('[::1]:8080'), { send: b.send });
  await v6('http://[::1]:8080/');
  await assert.rejects(v6('http://[::1]:8081/'), /private address/);

  // URL normalises 2130706433 to 127.0.0.1, so the declaration and the request compare as the same host.
  const c = scripted({ 'http://127.0.0.1:18199/': ok() });
  await createPluginFetch(net('127.0.0.1:18199'), { send: c.send })('http://2130706433:18199/');
  assert.equal(c.sent.length, 1);

  // Declaring 127.0.0.1 does not open localhost: it is a different name.
  const d = scripted({ 'http://localhost:18199/': ok() });
  await assert.rejects(createPluginFetch(net('127.0.0.1:18199'), { send: d.send })('http://localhost:18199/'), /private address/);
});

test('public hosts still work for a plugin with a declared host, through the public-only lookup', async () => {
  const { send, sent } = scripted({ 'http://93.184.216.34/x': ok('pub') });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  assert.equal(await (await fetchIt('http://93.184.216.34/x')).text(), 'pub');
  assert.equal(sent[0].lookup, PUBLIC_LOOKUP);
});

test('a plugin with no network permission gets the public-only fetch untouched', async () => {
  const pub = async () => new Response('x');
  assert.equal(createPluginFetch({ permissions: [] }, { publicFetch: pub }), pub);
  assert.equal(createPluginFetch({ permissions: [{ kind: 'llm' }] }, { publicFetch: pub }), pub);
  assert.equal(createPluginFetch({}, { publicFetch: pub }), pub);
});

test('a network permission with no detail, a wildcard, or a detail that does not parse opens nothing', () => {
  assert.deepEqual(declaredHosts({ permissions: [{ kind: 'network' }] }), []);
  assert.deepEqual(declaredHosts(net('*.example.com')), []);
  assert.deepEqual(declaredHosts(net('http://127.0.0.1/')), []);
  assert.deepEqual(declaredHosts(net('')), []);
  assert.deepEqual(declaredHosts(net('127.0.0.1:18199')), [{ host: '127.0.0.1', port: 18199, wildcard: false }]);
});

test('a redirect from the declared host to an undeclared private host is refused; the second request is never made', async () => {
  const { send, sent } = scripted({
    'http://127.0.0.1:18199/a': redirect('http://10.0.0.5/secret'),
    'http://127.0.0.1:18199/b': redirect('http://127.0.0.1:9999/'),
    'http://127.0.0.1:18199/c': redirect('http://169.254.169.254/latest/meta-data'),
    'http://10.0.0.5/secret': ok(),
  });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  await assert.rejects(fetchIt('http://127.0.0.1:18199/a'), /private address/);
  await assert.rejects(fetchIt('http://127.0.0.1:18199/b'), /private address/);
  await assert.rejects(fetchIt('http://127.0.0.1:18199/c'), /private address/);
  assert.deepEqual(sent.map((s) => s.url), ['http://127.0.0.1:18199/a', 'http://127.0.0.1:18199/b', 'http://127.0.0.1:18199/c']);
});

test('a redirect from the declared host to a public host is followed, on the public-only lookup', async () => {
  const { send, sent } = scripted({
    'http://127.0.0.1:18199/a': redirect('http://93.184.216.34/landing'),
    'http://93.184.216.34/landing': ok('landed'),
  });
  const res = await createPluginFetch(net('127.0.0.1:18199'), { send })('http://127.0.0.1:18199/a');
  assert.equal(await res.text(), 'landed');
  assert.equal(sent[1].lookup, PUBLIC_LOOKUP);
});

test('a redirect within the declared host, and from a public host into it, is followed; a relative Location resolves', async () => {
  const { send } = scripted({
    'http://127.0.0.1:18199/a': redirect('/b'),
    'http://127.0.0.1:18199/b': ok('same'),
    'http://93.184.216.34/in': redirect('http://127.0.0.1:18199/b'),
  });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  assert.equal(await (await fetchIt('http://127.0.0.1:18199/a')).text(), 'same');
  assert.equal(await (await fetchIt('http://93.184.216.34/in')).text(), 'same');
});

test('redirects to another scheme are refused, and a redirect loop stops', async () => {
  const { send } = scripted({
    'http://127.0.0.1:18199/a': redirect('file:///etc/passwd'),
    'http://127.0.0.1:18199/loop': redirect('/loop'),
  });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  await assert.rejects(fetchIt('http://127.0.0.1:18199/a'), /refusing file URL/);
  await assert.rejects(fetchIt('http://127.0.0.1:18199/loop'), /too many redirects/);
  await assert.rejects(fetchIt('ftp://127.0.0.1:18199/x'), /refusing ftp URL/);
  await assert.rejects(fetchIt('not a url'), /not a URL/);
});

test('credentials stay on a same-origin redirect and are dropped when the redirect changes origin', async () => {
  const { send, sent } = scripted({
    'http://127.0.0.1:18199/a': redirect('/b'),
    'http://127.0.0.1:18199/b': redirect('http://93.184.216.34/c'),
    'http://93.184.216.34/c': ok(),
  });
  const fetchIt = createPluginFetch(net('127.0.0.1:18199'), { send });
  await fetchIt('http://127.0.0.1:18199/a', { headers: { Authorization: 'Bearer t', 'X-Other': '1' } });
  assert.equal(sent[1].headers.get('authorization'), 'Bearer t');
  assert.equal(sent[2].headers.get('authorization'), null);
  assert.equal(sent[2].headers.get('x-other'), '1');
});

// --- through the plugin runtime, as a plugin author would hit it ------------

const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

/** A server.js whose GET /go?url= fetches that URL with ctx.fetch and reports the outcome. */
const PROBE_SERVER = [
  'export default {',
  '  activate(ctx) {',
  "    ctx.router.get('/go', async (req, res) => {",
  '      try {',
  '        const r = await ctx.fetch(String(req.query.url));',
  '        res.json({ status: r.status, body: await r.text() });',
  '      } catch (err) {',
  '        res.status(502).json({ error: err.message });',
  '      }',
  '    });',
  '  },',
  '};',
].join('\n');

async function probe(permissions: unknown[] | undefined, send: Send) {
  const h = makeRuntime({ send });
  harnesses.push(h);
  h.runtime.store.installFromZip(pluginPackage({ id: 'media.test.probe', server: PROBE_SERVER, permissions }), { source: 'upload' });
  await h.runtime.loadAll();
  assert.equal(h.runtime.status('media.test.probe')!.status, 'active');
  const srv = await listen(gatedApp(h.runtime, { id: 'member-1', role: 'contributor' }, true));
  servers.push(srv);
  return async (target: string) => {
    const res = await fetch(`${srv.base}/api/plugins/media.test.probe/go?url=${encodeURIComponent(target)}`);
    return { status: res.status, json: (await res.json()) as { status?: number; body?: string; error?: string } };
  };
}

test('ctx.fetch of a plugin declaring network 127.0.0.1:18199: that host works, a wrong port and an undeclared private host do not', async () => {
  const { send, sent } = scripted({ 'http://127.0.0.1:18199/x': ok('local') });
  const go = await probe([{ kind: 'network', detail: '127.0.0.1:18199' }], send);

  const good = await go('http://127.0.0.1:18199/x');
  assert.equal(good.status, 200);
  assert.deepEqual(good.json, { status: 200, body: 'local' });

  const wrongPort = await go('http://127.0.0.1:9999/x');
  assert.equal(wrongPort.status, 502);
  assert.match(wrongPort.json.error!, /private address/);

  const other = await go('http://10.0.0.5/x');
  assert.equal(other.status, 502);
  assert.match(other.json.error!, /private address/);

  assert.deepEqual(sent.map((s) => s.url), ['http://127.0.0.1:18199/x']);
});

test('ctx.fetch of a plugin with no network permission still refuses every private and loopback host', async () => {
  const { send, sent } = scripted({});
  for (const permissions of [undefined, [{ kind: 'llm' }], [{ kind: 'network' }], [{ kind: 'network', detail: '*.example.com' }]]) {
    const go = await probe(permissions, send);
    for (const target of ['http://127.0.0.1:18199/x', 'http://10.0.0.5/x', 'http://localhost/x', 'http://[::1]/x', 'http://169.254.169.254/']) {
      const res = await go(target);
      assert.equal(res.status, 502, target);
      assert.match(res.json.error!, /private address|refusing/, target);
    }
    await harnesses.pop()!.close();
    await servers.pop()!.close();
  }
  assert.equal(sent.length, 0);
});

test('ctx.fetch reaches a public host for a plugin with a declared host, and a redirect from it to a private one is refused', async () => {
  const { send } = scripted({
    'http://93.184.216.34/ok': ok('pub'),
    'http://127.0.0.1:18199/hop': redirect('http://10.0.0.5/'),
    'http://127.0.0.1:18199/pub': redirect('http://93.184.216.34/ok'),
  });
  const go = await probe([{ kind: 'network', detail: '127.0.0.1:18199' }], send);
  assert.deepEqual((await go('http://93.184.216.34/ok')).json, { status: 200, body: 'pub' });
  assert.deepEqual((await go('http://127.0.0.1:18199/pub')).json, { status: 200, body: 'pub' });
  const refused = await go('http://127.0.0.1:18199/hop');
  assert.equal(refused.status, 502);
  assert.match(refused.json.error!, /private address/);
});

// --- manifest ---------------------------------------------------------------

const base = {
  id: 'media.test.net',
  name: 'Net',
  version: '1.0.0',
  description: 'd',
  author: 'a',
  category: 'tools',
  photoscout: '^1.0',
};

function badDetail(detail: unknown): void {
  assert.throws(
    () => parseManifest({ ...base, permissions: [{ kind: 'network', detail }] }),
    (err: unknown) => err instanceof PluginError && /network permission|permission detail/.test(err.message),
    `expected ${JSON.stringify(detail)} to be refused`,
  );
}

test('manifest: a valid network host or host:port is accepted', () => {
  for (const detail of ['radio.garden', 'api.example.com:8443', '127.0.0.1', '127.0.0.1:18199', 'localhost:11434', 'my-nas', '[::1]', '[::1]:8080', '*.waze.com', '*.example.com:443']) {
    const m = parseManifest({ ...base, permissions: [{ kind: 'network', detail }] });
    assert.deepEqual(m.permissions, [{ kind: 'network', detail }], detail);
  }
  // No detail at all stays valid, as before.
  assert.deepEqual(parseManifest({ ...base, permissions: [{ kind: 'network' }] }).permissions, [{ kind: 'network' }]);
});

test('manifest: a network detail with a scheme, path, empty value or other junk is refused', () => {
  for (const detail of [
    '',
    ' ',
    'http://127.0.0.1:18199',
    'https://radio.garden',
    '127.0.0.1:18199/x',
    'radio.garden/',
    'host?x=1',
    'user@host',
    'a b',
    'host:',
    'host:0',
    'host:65536',
    'host:abc',
    'host:1:2',
    '*',
    '*.',
    '*.com:x',
    '*.127.0.0.1',
    '.example.com',
    'example..com',
    'example.com.',
    'LOCALHOST',
    '0x7f.1',
    '2130706433',
    '[0:0:0:0:0:0:0:1]',
    '[::1',
  ]) {
    badDetail(detail);
  }
  badDetail(42);
});

test('manifest: other permission kinds keep a free-form detail', () => {
  const m = parseManifest({ ...base, permissions: [{ kind: 'llm', detail: 'Sends photos to http://x/y for tagging' }, { kind: 'storage', detail: '' }] });
  assert.equal(m.permissions!.length, 2);
});

test('parseNetworkDetail reports host, port and wildcard', () => {
  assert.deepEqual(parseNetworkDetail('127.0.0.1:18199'), { host: '127.0.0.1', port: 18199, wildcard: false });
  assert.deepEqual(parseNetworkDetail('radio.garden'), { host: 'radio.garden', port: null, wildcard: false });
  assert.deepEqual(parseNetworkDetail('*.waze.com'), { host: 'waze.com', port: null, wildcard: true });
  assert.deepEqual(parseNetworkDetail('[::1]:8080'), { host: '[::1]', port: 8080, wildcard: false });
  assert.equal(parseNetworkDetail('http://x'), null);
});
