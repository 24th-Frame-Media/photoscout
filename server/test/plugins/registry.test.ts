import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginError } from '../../src/plugins/manifest.js';
import { SsrfError } from '../../src/ssrf.js';
import {
  addRegistry,
  createRemoteDeps,
  fetchGuarded,
  fetchRegistry,
  listRegistries,
  parseRegistry,
  removeRegistry,
  type RemoteDeps,
} from '../../src/plugins/remote.js';

/** The registry contract: parsing, the list of registries, and the guarded fetch (injected fetch, no network). */

const DEFAULT = 'https://registry.example/registry.json';
const SHA = 'a'.repeat(64);

function goodRegistry(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    plugins: [
      {
        id: 'map.example.demo',
        name: 'Demo',
        description: 'A demo',
        author: 'Tests',
        homepage: 'https://example.com',
        category: 'map',
        latest: '1.2.0',
        versions: [
          { version: '1.0.0', zip: 'https://cdn.example/demo-1.0.0.zip', sha256: SHA, minCore: '^1.0', size: 10 },
          { version: '1.2.0', zip: 'https://cdn.example/demo-1.2.0.zip', sha256: SHA.toUpperCase() },
        ],
        ...over,
      },
    ],
  };
}

function deps(over: Partial<RemoteDeps> = {}): RemoteDeps {
  return createRemoteDeps({ defaultRegistry: DEFAULT, assertUrl: async () => undefined, ...over });
}

function reply(body: string | Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body as BodyInit, { status: 200, ...init });
}

async function refused(p: Promise<unknown>, status: number, match?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PluginError, `PluginError expected, got ${String(err)}`);
    assert.equal(err.status, status, err.message);
    if (match) assert.match(err.message, match);
    return;
  }
  assert.fail('expected a refusal');
}

test('a valid registry parses, lowercases sha256 and keeps the contract fields', () => {
  const [p] = parseRegistry(goodRegistry());
  assert.equal(p.id, 'map.example.demo');
  assert.equal(p.latest, '1.2.0');
  assert.equal(p.category, 'map');
  assert.equal(p.versions[1].sha256, SHA);
  assert.equal(p.versions[0].minCore, '^1.0');
  assert.equal(p.versions[0].size, 10);
});

test('latest defaults to the highest version when a registry leaves it out', () => {
  const [p] = parseRegistry(goodRegistry({ latest: undefined }));
  assert.equal(p.latest, '1.2.0');
});

test('malformed registries are rejected', () => {
  const one = (v: Record<string, unknown>) => goodRegistry({ versions: [{ version: '1.0.0', zip: 'https://x.example/a.zip', sha256: SHA, ...v }], latest: '1.0.0' });
  const bad: [string, unknown][] = [
    ['not an object', []],
    ['wrong version', { version: 2, plugins: [] }],
    ['no plugins list', { version: 1 }],
    ['bad id', goodRegistry({ id: 'NoDots' })],
    ['no versions', goodRegistry({ versions: [] })],
    ['latest not listed', goodRegistry({ latest: '9.9.9' })],
    ['non-semver version', one({ version: 'v1' })],
    ['http zip', one({ zip: 'http://x.example/a.zip' })],
    ['short sha', one({ sha256: 'abc' })],
    ['non-hex sha', one({ sha256: 'z'.repeat(64) })],
    ['bad size', one({ size: -1 })],
    ['bad minCore', one({ minCore: 'nope' })],
    ['missing name', goodRegistry({ name: undefined })],
  ];
  for (const [label, json] of bad) assert.throws(() => parseRegistry(json), PluginError, label);
  const dup = goodRegistry();
  assert.throws(() => parseRegistry({ version: 1, plugins: [dup.plugins[0], dup.plugins[0]] }), /listed twice/);
});

test('registries: the default is first and undeletable; custom ones are added, deduped and removed', async () => {
  const d = deps();
  assert.deepEqual(listRegistries(d), [{ url: DEFAULT, isDefault: true }]);
  const added = await addRegistry(d, 'https://other.example/r.json#frag');
  assert.deepEqual(added, [{ url: DEFAULT, isDefault: true }, { url: 'https://other.example/r.json', isDefault: false }]);
  await refused(addRegistry(d, 'https://other.example/r.json'), 400, /already added/);
  await refused(addRegistry(d, DEFAULT), 400, /already added/);
  await assert.rejects(async () => removeRegistry(d, DEFAULT), (e: PluginError) => e.status === 400 && /default/.test(e.message));
  await assert.rejects(async () => removeRegistry(d, 'https://nope.example/r.json'), (e: PluginError) => e.status === 404);
  assert.deepEqual(removeRegistry(d, 'https://other.example/r.json'), [{ url: DEFAULT, isDefault: true }]);
});

test('registries: only https URLs without credentials, and only ones the SSRF guard allows', async () => {
  await refused(addRegistry(deps(), 'http://other.example/r.json'), 400, /https/);
  await refused(addRegistry(deps(), 'ftp://other.example/r.json'), 400);
  await refused(addRegistry(deps(), 'https://user:pw@other.example/r.json'), 400, /credentials/);
  await refused(addRegistry(deps(), 'not a url'), 400);
  await refused(addRegistry(deps(), 42), 400);
  // The real guard, on literal addresses (no DNS needed).
  const real = createRemoteDeps({ defaultRegistry: DEFAULT });
  for (const u of ['https://127.0.0.1/r.json', 'https://169.254.169.254/latest', 'https://10.0.0.5/r.json', 'https://[::1]/r.json']) {
    await refused(addRegistry(real, u), 400, /refused/);
  }
  assert.equal(listRegistries(real).length, 1);
});

test('GET registry: only configured registries are fetched, no open proxy', async () => {
  let calls = 0;
  const d = deps({ fetch: async () => (calls++, reply(JSON.stringify(goodRegistry()))) });
  await refused(fetchRegistry(d, 'https://evil.example/r.json'), 400, /not configured/);
  assert.equal(calls, 0);
  const got = await fetchRegistry(d, DEFAULT);
  assert.equal(got.plugins.length, 1);
  assert.equal((await fetchRegistry(d, undefined)).url, DEFAULT, 'no url means the default');
});

test('GET registry: bad JSON, bad shape, HTTP errors and oversize bodies are refused with clear errors', async () => {
  await refused(fetchRegistry(deps({ fetch: async () => reply('<html>') }), DEFAULT), 502, /not valid JSON/);
  await refused(fetchRegistry(deps({ fetch: async () => reply('{"version":1}') }), DEFAULT), 502, /plugins/);
  await refused(fetchRegistry(deps({ fetch: async () => reply('x', { status: 404 }) }), DEFAULT), 502, /HTTP 404/);
  const big = new Uint8Array(1024 * 1024 + 1);
  await refused(fetchRegistry(deps({ fetch: async () => reply(big) }), DEFAULT), 413);
  // Chunked, no content-length: the cap still applies while reading.
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(512 * 1024)); } });
  await refused(fetchRegistry(deps({ fetch: async () => new Response(stream) }), DEFAULT), 413);
});

test('fetchGuarded: every redirect hop is held to https and the SSRF check', async () => {
  const guard = async (u: string) => {
    if (u.includes('169.254.169.254')) throw new SsrfError('private address');
  };
  const redirectTo = (loc: string) => async () => new Response(null, { status: 302, headers: { location: loc } });
  const opts = { maxBytes: 100, timeoutMs: 1000, what: 'The thing' };
  await refused(fetchGuarded(deps({ assertUrl: guard, fetch: redirectTo('https://169.254.169.254/x') }), 'https://ok.example/a', opts), 400, /refused/);
  await refused(fetchGuarded(deps({ fetch: redirectTo('http://plain.example/x') }), 'https://ok.example/a', opts), 400, /https/);
  let n = 0;
  const loop = async () => (n++, new Response(null, { status: 302, headers: { location: `https://ok.example/${n}` } }));
  await refused(fetchGuarded(deps({ fetch: loop }), 'https://ok.example/a', opts), 502, /redirected too many/);
  const hop = async (u: string) => (u.endsWith('/a') ? new Response(null, { status: 301, headers: { location: '/b' } }) : reply('hi'));
  assert.equal((await fetchGuarded(deps({ fetch: hop }), 'https://ok.example/a', opts)).toString(), 'hi');
});

test('fetchGuarded: a request that outlives the timeout is aborted', async () => {
  const slow = (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
    init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await refused(fetchGuarded(deps({ fetch: slow }), 'https://ok.example/a', { maxBytes: 100, timeoutMs: 30, what: 'The thing' }), 504, /timed out/);
});
