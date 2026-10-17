import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRemoteDeps, MAX_REGISTRY_BYTES, type RemoteDeps } from '../../src/plugins/remote.js';
import { MAX_PACKAGE_BYTES } from '../../src/plugins/archive.js';
import { listen, makeRuntime, pluginApp, pluginPackage, zipOf, type Harness, type Listening } from './helpers.js';

/** Install from a registry over HTTP, with the registry and the zips served by a fake fetch. */

const REGISTRY = 'https://registry.example/registry.json';
const ID = 'media.test.demo';

const harnesses: Harness[] = [];
const servers: Listening[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Served {
  /** url -> body (or a ready Response) */
  files: Map<string, Uint8Array | string | Response>;
  hits: string[];
}

function fakeNet(): { served: Served; fetch: RemoteDeps['fetch'] } {
  const served: Served = { files: new Map(), hits: [] };
  return {
    served,
    fetch: async (url) => {
      served.hits.push(url);
      const f = served.files.get(url);
      if (f === undefined) return new Response('nope', { status: 404 });
      return f instanceof Response ? f : new Response(f as BodyInit, { status: 200 });
    },
  };
}

function registryFor(zips: { version: string; zip: Uint8Array; url?: string; sha256?: string }[], over: Record<string, unknown> = {}) {
  return {
    version: 1,
    plugins: [
      {
        id: ID,
        name: 'Demo',
        description: 'A demo plugin',
        author: 'Tests',
        category: 'tools',
        latest: zips[zips.length - 1].version,
        versions: zips.map((z) => ({ version: z.version, zip: z.url ?? `https://cdn.example/demo-${z.version}.zip`, sha256: z.sha256 ?? sha(z.zip), size: z.zip.byteLength })),
        ...over,
      },
    ],
  };
}

async function setup(opts: { realGuard?: boolean } = {}) {
  const h = makeRuntime();
  harnesses.push(h);
  const net = fakeNet();
  const deps: Partial<RemoteDeps> = { fetch: net.fetch, defaultRegistry: REGISTRY };
  if (!opts.realGuard) deps.assertUrl = async () => undefined;
  const s = await listen(pluginApp(h.runtime, undefined, deps));
  servers.push(s);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${s.base}/api/admin/plugins${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { h, net, call };
}

test('install-remote: resolves latest, verifies sha256, installs with source "repository"', async () => {
  const { h, net, call } = await setup();
  const v1 = pluginPackage({ id: ID, version: '1.0.0' });
  const v2 = pluginPackage({ id: ID, version: '2.0.0' });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip: v1 }, { version: '2.0.0', zip: v2 }])));
  net.served.files.set('https://cdn.example/demo-1.0.0.zip', v1);
  net.served.files.set('https://cdn.example/demo-2.0.0.zip', v2);

  const listed = await call('GET', `/registry?url=${encodeURIComponent(REGISTRY)}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.plugins[0].latest, '2.0.0');

  const res = await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID });
  assert.equal(res.status, 201);
  assert.deepEqual({ ok: res.json.ok, id: res.json.id, version: res.json.version }, { ok: true, id: ID, version: '2.0.0' });
  assert.equal(res.json.status.status, 'active');
  assert.equal(h.runtime.store.get(ID)?.source, 'repository');

  // A named older version is honoured and updates in place (200, not 201).
  const older = await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID, version: '1.0.0' });
  assert.equal(older.status, 200);
  assert.equal(older.json.version, '1.0.0');
});

test('preview-remote: shows permissions from the verified manifest and installs nothing', async () => {
  const { h, net, call } = await setup();
  const zip = zipOf({
    'plugin.json': JSON.stringify({ id: ID, name: 'Demo', version: '1.0.0', description: 'd', author: 'a', category: 'tools', photoscout: '^1.0', permissions: [{ kind: 'network', detail: 'api.example.com' }] }),
  });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip }])));
  net.served.files.set('https://cdn.example/demo-1.0.0.zip', zip);
  const res = await call('POST', '/preview-remote', { registryUrl: REGISTRY, id: ID });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.permissions, [{ kind: 'network', detail: 'api.example.com' }]);
  assert.equal(res.json.sha256, sha(zip));
  assert.equal(h.runtime.store.get(ID), null);
});

test('install-remote: a sha256 mismatch is refused and nothing is installed', async () => {
  const { h, net, call } = await setup();
  const good = pluginPackage({ id: ID, version: '1.0.0' });
  const tampered = pluginPackage({ id: ID, version: '1.0.0', server: 'export default { activate() {} };' });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip: good }])));
  net.served.files.set('https://cdn.example/demo-1.0.0.zip', tampered);
  const res = await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /Checksum mismatch/);
  assert.equal(h.runtime.store.get(ID), null);
});

test('install-remote: the zip must be the id and version the registry promised', async () => {
  const { h, net, call } = await setup();
  const other = pluginPackage({ id: 'media.test.other', version: '1.0.0' });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip: other }])));
  net.served.files.set('https://cdn.example/demo-1.0.0.zip', other);
  const res = await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /not the media\.test\.demo@1\.0\.0/);
  assert.equal(h.runtime.store.get('media.test.other'), null);
  assert.equal(h.runtime.store.get(ID), null);
});

test('install-remote: unknown registry, plugin, version and bad bodies get clear errors', async () => {
  const { net, call } = await setup();
  const zip = pluginPackage({ id: ID, version: '1.0.0' });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip }])));
  const notConfigured = await call('POST', '/install-remote', { registryUrl: 'https://evil.example/r.json', id: ID });
  assert.equal(notConfigured.status, 400);
  assert.match(notConfigured.json.error, /not configured/);
  assert.ok(!net.served.hits.includes('https://evil.example/r.json'));
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY, id: 'media.nope.nope' })).status, 404);
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID, version: '9.9.9' })).status, 404);
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY })).status, 400);
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID, version: 5 })).status, 400);
  assert.equal((await call('POST', '/install-remote')).status, 400);
});

test('install-remote: an oversize package is refused (declared and streamed) and nothing is installed', async () => {
  const { h, net, call } = await setup();
  const zip = pluginPackage({ id: ID, version: '1.0.0' });
  net.served.files.set(REGISTRY, JSON.stringify(registryFor([{ version: '1.0.0', zip }])));
  const url = 'https://cdn.example/demo-1.0.0.zip';
  net.served.files.set(url, new Response(null, { status: 200, headers: { 'content-length': String(MAX_PACKAGE_BYTES + 1) } }));
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID })).status, 413);

  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); } });
  net.served.files.set(url, new Response(stream, { status: 200 }));
  assert.equal((await call('POST', '/install-remote', { registryUrl: REGISTRY, id: ID })).status, 413);
  assert.equal(h.runtime.store.get(ID), null);
  assert.ok(MAX_REGISTRY_BYTES < MAX_PACKAGE_BYTES);
});

test('install-remote: a zip URL the SSRF guard refuses is never fetched', async () => {
  const { h, net, call } = await setup({ realGuard: true });
  const zip = pluginPackage({ id: ID, version: '1.0.0' });
  // The registry host is a public literal so the real guard passes without DNS; the zip points at the metadata address.
  const reg = 'https://93.184.216.34/registry.json';
  assert.equal((await call('POST', '/registries', { url: reg })).status, 200);
  net.served.files.set(reg, JSON.stringify(registryFor([{ version: '1.0.0', zip, url: 'https://169.254.169.254/latest/meta-data/x.zip' }])));
  const res = await call('POST', '/install-remote', { registryUrl: reg, id: ID });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /refused/);
  assert.ok(!net.served.hits.some((u) => u.includes('169.254')), 'the refused URL was not requested');
  assert.equal(h.runtime.store.get(ID), null);
  // And a custom registry on a private address cannot even be added.
  assert.equal((await call('POST', '/registries', { url: 'https://10.0.0.1/r.json' })).status, 400);
});

test('registries endpoints: list, add, duplicate, remove, and the default stays', async () => {
  const { call } = await setup();
  const first = await call('GET', '/registries');
  assert.deepEqual(first.json.registries, [{ url: REGISTRY, isDefault: true }]);
  const added = await call('POST', '/registries', { url: 'https://other.example/registry.json' });
  assert.equal(added.status, 200);
  assert.equal(added.json.registries.length, 2);
  assert.equal((await call('POST', '/registries', { url: 'https://other.example/registry.json' })).status, 400);
  assert.equal((await call('POST', '/registries', { url: 'http://insecure.example/registry.json' })).status, 400);
  assert.equal((await call('DELETE', '/registries', { url: REGISTRY })).status, 400);
  const removed = await call('DELETE', '/registries', { url: 'https://other.example/registry.json' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.registries, [{ url: REGISTRY, isDefault: true }]);
});

test('createRemoteDeps: the stored list survives a new deps object over the same kv', async () => {
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
  const a = createRemoteDeps({ kv: store, defaultRegistry: REGISTRY, assertUrl: async () => undefined });
  const { addRegistry, listRegistries } = await import('../../src/plugins/remote.js');
  await addRegistry(a, 'https://other.example/registry.json');
  const b = createRemoteDeps({ kv: store, defaultRegistry: REGISTRY });
  assert.equal(listRegistries(b).length, 2);
});
