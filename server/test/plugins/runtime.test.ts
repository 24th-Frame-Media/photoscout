import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRuntime, PING_SERVER, pluginApp, listen, pluginPackage, removeRoot, tempRoot, type Harness, type Listening } from './helpers.js';
import { PluginError } from '../../src/plugins/manifest.js';

/**
 * The lifecycle, exercised through the runtime and its dispatcher: a plugin
 * that fails must not take the host down, and enabling, updating, rolling back
 * and disabling must all happen without a restart.
 */

const harnesses: Harness[] = [];
const servers: Listening[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of extraDirs.splice(0)) removeRoot(d);
});

function harness(opts: Parameters<typeof makeRuntime>[0] = {}): Harness {
  const h = makeRuntime(opts);
  harnesses.push(h);
  return h;
}

async function serve(h: Harness): Promise<string> {
  const s = await listen(pluginApp(h.runtime));
  servers.push(s);
  return s.base;
}

const ID = 'media.test.demo';

test('a plugin that throws while starting is marked as an error and the host keeps serving', async () => {
  const h = harness();
  const id = 'media.test.broken';
  h.runtime.store.installFromZip(
    pluginPackage({ id, server: "export default { activate() { throw new Error('boom at start'); } };" }),
    { source: 'upload' },
  );
  const status = await h.runtime.activate(id);
  assert.equal(status.status, 'error');
  assert.match(status.lastError, /boom at start/);

  const base = await serve(h);
  assert.equal((await fetch(`${base}/health`)).status, 200, 'the host still answers');
  const ping = await fetch(`${base}/api/plugins/${id}/ping`);
  assert.equal(ping.status, 404);
  assert.deepEqual(await ping.json(), { error: 'Plugin not active' });
});

test('a rejected or thrown handler answers 500 "Plugin failed", is logged, and does not crash the host', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      server: [
        'export default { activate(ctx) {',
        "  ctx.router.get('/boom', async () => { throw new Error('async kaboom'); });",
        "  ctx.router.get('/sync', () => { throw new Error('sync kaboom'); });",
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );
  assert.equal((await h.runtime.activate(ID)).status, 'active');
  const base = await serve(h);

  const asyncRes = await fetch(`${base}/api/plugins/${ID}/boom`);
  assert.equal(asyncRes.status, 500);
  assert.deepEqual(await asyncRes.json(), { error: 'Plugin failed' });

  const syncRes = await fetch(`${base}/api/plugins/${ID}/sync`);
  assert.equal(syncRes.status, 500);

  const messages = h.runtime.logs(ID).map((e) => e.message).join('\n');
  assert.match(messages, /async kaboom/);
  assert.match(messages, /sync kaboom/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('an update swaps to the new version without a restart, and a rollback swaps back', async () => {
  const h = harness();
  h.runtime.store.installFromZip(pluginPackage({ id: ID, version: '1.0.0' }), { source: 'upload' });
  await h.runtime.activate(ID);
  const base = await serve(h);
  const version = async () => ((await (await fetch(`${base}/api/plugins/${ID}/ping`)).json()) as { version: string }).version;
  assert.equal(await version(), '1.0.0');

  h.runtime.store.installFromZip(pluginPackage({ id: ID, version: '2.0.0' }), { source: 'upload' });
  const updated = await h.runtime.reload(ID);
  assert.equal(updated.status, 'active');
  assert.equal(updated.version, '2.0.0');
  assert.equal(updated.previousVersion, '1.0.0');
  assert.equal(await version(), '2.0.0');

  h.runtime.store.rollback(ID);
  await h.runtime.reload(ID);
  assert.equal(await version(), '1.0.0');
});

test('disable stops the plugin answering, enable brings it back', async () => {
  const h = harness();
  h.runtime.store.installFromZip(pluginPackage({ id: ID }), { source: 'upload' });
  await h.runtime.activate(ID);
  const base = await serve(h);
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 200);

  const off = await h.runtime.setEnabled(ID, false);
  assert.equal(off.status, 'disabled');
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 404);

  const on = await h.runtime.setEnabled(ID, true);
  assert.equal(on.status, 'active');
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 200);
});

test('tasks appear while the plugin runs, can be run, and go when it stops', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      server: [
        'export default { activate(ctx) {',
        "  ctx.tasks.register({ id: 'sweep', name: 'Sweep', description: 'Tidies up', intervalMinutes: null,",
        "    run: async (log) => { log('working'); return { ok: true, message: 'swept' }; } });",
        "  ctx.tasks.register({ id: 'hourly', name: 'Hourly', intervalMinutes: 60, run: async () => ({ ok: true, message: 'done' }) });",
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );
  await h.runtime.activate(ID);
  const names = h.registry.list().map((d) => d.name);
  assert.ok(names.includes(`plugin:${ID}:sweep`));
  assert.ok(names.includes(`plugin:${ID}:hourly`));
  assert.equal(h.registry.status(`plugin:${ID}:sweep`)?.label, 'Demo: Sweep');
  assert.deepEqual(await h.registry.run(`plugin:${ID}:sweep`), { ok: true, message: 'swept' });

  await h.runtime.deactivate(ID);
  assert.equal(h.registry.list().some((d) => d.name.startsWith(`plugin:${ID}:`)), false);
});

test('safe mode starts nothing, however the plugins are asked', async () => {
  const h = harness({ safeMode: true });
  h.runtime.store.installFromZip(pluginPackage({ id: ID }), { source: 'upload' });
  await h.runtime.loadAll();
  assert.equal(h.runtime.meta().safeMode, true);
  assert.equal(h.runtime.status(ID)?.status, 'inactive');
  const refused = await h.runtime.activate(ID);
  assert.equal(refused.status, 'inactive');
  const base = await serve(h);
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 404);
});

test('after more than five reloads the host recommends a restart', async () => {
  const h = harness();
  h.runtime.store.installFromZip(pluginPackage({ id: ID }), { source: 'upload' });
  await h.runtime.activate(ID);
  for (let i = 0; i < 5; i++) await h.runtime.reload(ID);
  assert.equal(h.runtime.meta().restartRecommended, false);
  await h.runtime.reload(ID);
  assert.equal(h.runtime.meta().restartRecommended, true);
});

test('settings reach the plugin, change listeners fire, and service addresses resolve', async () => {
  const h = harness();
  const settings = [
    { key: 'city', type: 'string', label: 'City', default: 'Sydney' },
    { key: 'apiKey', type: 'secret', label: 'Key' },
  ];
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      settings,
      server: [
        'const seen = [];',
        'export default { activate(ctx) {',
        "  ctx.settings.onChange((s) => seen.push(s.city));",
        "  ctx.router.get('/config', (req, res) => { const s = ctx.settings.get(); res.json({ city: s.city, key: s.apiKey ?? null, service: ctx.services.url('worker') }); });",
        "  ctx.router.get('/seen', (req, res) => res.json(seen));",
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );
  await h.runtime.activate(ID);
  const base = await serve(h);
  const config = async () => (await (await fetch(`${base}/api/plugins/${ID}/config`)).json()) as Record<string, unknown>;

  assert.equal((await config()).city, 'Sydney', 'defaults apply before anything is saved');

  h.runtime.updateSettings(ID, { city: 'Bathurst', apiKey: 'k1', 'service:worker:url': 'http://worker.internal:9000' });
  assert.deepEqual(await config(), { city: 'Bathurst', key: 'k1', service: 'http://worker.internal:9000' });
  assert.deepEqual(await (await fetch(`${base}/api/plugins/${ID}/seen`)).json(), ['Bathurst']);

  h.runtime.updateSettings(ID, { apiKey: '' });
  assert.equal((await config()).key, 'k1', 'a blank secret keeps the stored one');
  h.runtime.updateSettings(ID, { apiKey: null });
  assert.equal((await config()).key, '', 'null clears a secret to empty');

  const view = h.runtime.settings(ID);
  assert.equal(view.values.city, 'Bathurst');
  assert.deepEqual(view.secretsSet, { apiKey: false });
});

test('the plugin database is its own file, not a table in the core database', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      server: [
        'export default { activate(ctx) {',
        "  ctx.db.exec('CREATE TABLE IF NOT EXISTS hits (n INTEGER)');",
        "  ctx.db.exec('INSERT INTO hits (n) VALUES (1)');",
        "  ctx.router.get('/hits', (req, res) => res.json(ctx.db.prepare('SELECT COUNT(*) AS c FROM hits').get()));",
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );
  await h.runtime.activate(ID);
  const base = await serve(h);
  assert.deepEqual(await (await fetch(`${base}/api/plugins/${ID}/hits`)).json(), { c: 1 });
  assert.equal(fs.existsSync(path.join(h.runtime.store.dataDir(ID), 'plugin.db')), true);
  assert.equal(h.handle.prepare("SELECT name FROM sqlite_master WHERE name = 'hits'").get(), undefined);
});

test('ctx.fetch refuses private addresses', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      server: [
        'export default { activate(ctx) {',
        "  ctx.router.get('/fetch', async (req, res) => {",
        "    try { await ctx.fetch('http://127.0.0.1:9/'); res.json({ fetched: true }); }",
        '    catch (err) { res.json({ refused: err.message }); }',
        '  });',
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );
  await h.runtime.activate(ID);
  const base = await serve(h);
  const body = (await (await fetch(`${base}/api/plugins/${ID}/fetch`)).json()) as { refused?: string };
  assert.match(body.refused ?? '', /private/);
});

test('dev mode loads an unpacked plugin from the dev folder and records it as a dev plugin', async () => {
  const devRoot = tempRoot();
  extraDirs.push(devRoot);
  const devId = 'media.test.dev';
  const dir = path.join(devRoot, devId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ id: devId, name: 'Dev', version: '0.1.0', description: 'd', author: 'a', category: 'tools', photoscout: '^1.0', server: 'server.js' }),
  );
  fs.writeFileSync(path.join(dir, 'server.js'), PING_SERVER);

  const h = harness({ devMode: true, devRoot });
  await h.runtime.loadAll();
  const status = h.runtime.status(devId);
  assert.equal(status?.status, 'active');
  assert.equal(status?.source, 'dev');
  const base = await serve(h);
  const ping = (await (await fetch(`${base}/api/plugins/${devId}/ping`)).json()) as { version: string };
  assert.equal(ping.version, '0.1.0');
});

test('a plugin with no server entry is active, and simply has no routes', async () => {
  const h = harness();
  h.runtime.store.installFromZip(pluginPackage({ id: ID, server: null, web: true }), { source: 'upload' });
  const status = await h.runtime.activate(ID);
  assert.equal(status.status, 'active');
  assert.deepEqual(h.runtime.webEntries().map((w) => w.web), [`/plugins/${ID}/1.0.0/web.js`]);
});

test('in dev mode, saving server.js reloads the plugin without a restart', async () => {
  const devRoot = tempRoot();
  extraDirs.push(devRoot);
  const devId = 'media.test.watched';
  const dir = path.join(devRoot, devId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: devId, name: 'Watched', version: '0.1.0', description: 'd', author: 'a', category: 'tools', photoscout: '^1.0', server: 'server.js' };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'server.js'), PING_SERVER);

  const h = harness({ devMode: true, devRoot });
  await h.runtime.loadAll();
  const base = await serve(h);
  assert.equal(((await (await fetch(`${base}/api/plugins/${devId}/ping`)).json()) as { version: string }).version, '0.1.0');

  fs.writeFileSync(
    path.join(dir, 'server.js'),
    "export default { activate(ctx) { ctx.router.get('/ping', (req, res) => res.json({ marker: 'second' })); } };",
  );
  let marker: unknown = null;
  for (let i = 0; i < 50 && marker !== 'second'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fetch(`${base}/api/plugins/${devId}/ping`);
    if (res.status === 200) marker = ((await res.json()) as { marker?: unknown }).marker;
  }
  assert.equal(marker, 'second', 'the saved file was picked up within five seconds');
});

test('an upload and a rollback of one plugin run one after the other, whichever is asked first', async () => {
  const h = harness();
  const SLOW = [
    'export default {',
    '  async activate(ctx) {',
    '    await new Promise((done) => setTimeout(done, 150));',
    "    ctx.router.get('/ping', (req, res) => res.json({ id: ctx.manifest.id, version: ctx.manifest.version }));",
    '  },',
    '};',
  ].join('\n');
  await h.runtime.installPackage(pluginPackage({ id: ID, version: '1.0.0' }));
  // The upgrade is still starting when the rollback is asked for: the rollback has to wait for it, or it would find no earlier version.
  const upgrade = h.runtime.installPackage(pluginPackage({ id: ID, version: '2.0.0', server: SLOW }));
  const back = h.runtime.rollback(ID);
  assert.equal((await upgrade).created, false);
  assert.equal((await back).version, '1.0.0');
  assert.equal(h.runtime.store.get(ID)?.activeVersion, '1.0.0');
  assert.equal(h.runtime.store.get(ID)?.previousVersion, '2.0.0');
});

test('a plugin whose package can no longer be read shows no settings, and its settings cannot be changed', async () => {
  const h = harness();
  const settings = [
    { key: 'radius', type: 'number', label: 'Radius' },
    { key: 'apiKey', type: 'secret', label: 'API key' },
  ];
  await h.runtime.installPackage(pluginPackage({ id: ID, settings }));
  h.runtime.updateSettings(ID, { radius: 5, apiKey: 'abc' });
  await h.runtime.setEnabled(ID, false);
  fs.rmSync(path.join(h.runtime.store.versionDir(ID, '1.0.0'), 'plugin.json'));

  assert.deepEqual(h.runtime.settings(ID), { values: {}, secretsSet: {} });
  assert.throws(() => h.runtime.updateSettings(ID, { radius: 6 }), (err: unknown) => err instanceof PluginError);
});
