import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRuntime, pluginApp, listen, pluginPackage, rawGet, removeRoot, uploadPackage, zipOf, type Harness, type Listening } from './helpers.js';

/**
 * The HTTP surface: the admin API (upload, enable, update, rollback, uninstall,
 * settings, logs), the public list of web bundles, and the static file route.
 */

const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

const ID = 'media.test.demo';

function setup(caller: Parameters<typeof pluginApp>[1] = { user: { id: 'admin-1', role: 'admin' } }) {
  const h = makeRuntime();
  harnesses.push(h);
  return { h, caller };
}

async function serve(h: Harness, caller?: Parameters<typeof pluginApp>[1]): Promise<string> {
  const s = await listen(pluginApp(h.runtime, caller));
  servers.push(s);
  return s.base;
}

function json(res: Response): Promise<Record<string, any>> {
  return res.json() as Promise<Record<string, any>>;
}

test('an uploaded package is installed, started, and answers under /api/plugins/<id>', async () => {
  const { h } = setup();
  const base = await serve(h);
  const up = await uploadPackage(base, pluginPackage({ id: ID, version: '1.0.0' }));
  assert.equal(up.status, 201);
  const body = await json(up);
  assert.equal(body.ok, true);
  assert.equal(body.status.status, 'active');

  const ping = await fetch(`${base}/api/plugins/${ID}/ping`);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { id: ID, version: '1.0.0' });

  const list = await json(await fetch(`${base}/api/admin/plugins`));
  assert.equal(list.hostApiVersion, '1.1.0');
  assert.equal(list.plugins[0].id, ID);
  assert.equal(list.plugins[0].status, 'active');
});

test('a package the host cannot run is refused with 400 and the reason', async () => {
  const { h } = setup();
  const base = await serve(h);
  const res = await uploadPackage(base, pluginPackage({ id: ID, photoscout: '^2.0' }));
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /needs PhotoScout plugin API \^2\.0/);
  assert.equal(h.runtime.store.get(ID), null);
});

test('a plugin that does not start is rolled back out of the way, with 422 and the reason', async () => {
  const { h } = setup();
  const base = await serve(h);
  const broken = pluginPackage({ id: ID, server: "export default { activate() { throw new Error('nope at boot'); } };" });
  const res = await uploadPackage(base, broken);
  assert.equal(res.status, 422);
  assert.match((await json(res)).error, /did not start: nope at boot/);
  assert.equal(h.runtime.store.get(ID), null, 'a first install that fails is removed');
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('an update that does not start leaves the working version running', async () => {
  const { h } = setup();
  const base = await serve(h);
  assert.equal((await uploadPackage(base, pluginPackage({ id: ID, version: '1.0.0' }))).status, 201);

  const broken = pluginPackage({ id: ID, version: '2.0.0', server: "export default { activate() { throw new Error('bad update'); } };" });
  const res = await uploadPackage(base, broken);
  assert.equal(res.status, 422);
  assert.match((await json(res)).error, /Version 1\.0\.0 is running again/);

  const ping = await (await fetch(`${base}/api/plugins/${ID}/ping`)).json();
  assert.equal(ping.version, '1.0.0');
  assert.equal(h.runtime.store.get(ID)?.activeVersion, '1.0.0');
});

test('an update hot-swaps, and rollback returns the earlier version', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, version: '1.0.0' }));
  const up = await uploadPackage(base, pluginPackage({ id: ID, version: '2.0.0' }));
  assert.equal(up.status, 200, 'an update to an existing plugin is 200');
  assert.equal((await (await fetch(`${base}/api/plugins/${ID}/ping`)).json()).version, '2.0.0');

  const back = await fetch(`${base}/api/admin/plugins/${ID}/rollback`, { method: 'POST' });
  assert.equal(back.status, 200);
  assert.equal((await json(back)).version, '1.0.0');
  assert.equal((await (await fetch(`${base}/api/plugins/${ID}/ping`)).json()).version, '1.0.0');
});

test('rollback with nothing earlier is a conflict', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, version: '1.0.0' }));
  const res = await fetch(`${base}/api/admin/plugins/${ID}/rollback`, { method: 'POST' });
  assert.equal(res.status, 409);
});

test('enable and disable switch the routes off and on', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID }));
  assert.equal((await fetch(`${base}/api/admin/plugins/${ID}/disable`, { method: 'POST' })).status, 200);
  const off = await fetch(`${base}/api/plugins/${ID}/ping`);
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), { error: 'Plugin not active' });
  assert.equal((await json(await fetch(`${base}/api/admin/plugins/${ID}/enable`, { method: 'POST' }))).status, 'active');
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 200);
});

test('uninstall keeps the plugin data only when asked to', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID }));
  const dataFile = path.join(h.runtime.store.dataDir(ID), 'mine.txt');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, 'keep');

  const kept = await fetch(`${base}/api/admin/plugins/${ID}?keepData=1`, { method: 'DELETE' });
  assert.equal(kept.status, 200);
  assert.equal((await fetch(`${base}/api/plugins/${ID}/ping`)).status, 404);
  assert.equal(fs.existsSync(dataFile), true);

  await uploadPackage(base, pluginPackage({ id: ID }));
  await fetch(`${base}/api/admin/plugins/${ID}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(path.join(h.root, ID)), false);
});

test('an unknown plugin is a 404 from the admin API', async () => {
  const { h } = setup();
  const base = await serve(h);
  assert.equal((await fetch(`${base}/api/admin/plugins/media.nobody.here/enable`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/plugins/media.nobody.here/settings`)).status, 404);
});

test('the admin API is for admins only', async () => {
  const { h } = setup({ user: { id: 'member-1', role: 'contributor' } });
  const base = await serve(h, { user: { id: 'member-1', role: 'contributor' } });
  assert.equal((await fetch(`${base}/api/admin/plugins`)).status, 403);
  assert.equal((await uploadPackage(base, pluginPackage({ id: ID }))).status, 403);
  assert.equal(h.runtime.store.get(ID), null);
});

test('settings are redacted on the way out, kept when blank, cleared when null, and checked on the way in', async () => {
  const { h } = setup();
  const base = await serve(h);
  const settings = [
    { key: 'radius', type: 'number', label: 'Radius', min: 1, max: 50, default: 10 },
    { key: 'apiKey', type: 'secret', label: 'API key' },
  ];
  await uploadPackage(base, pluginPackage({ id: ID, settings }));

  const put = (body: unknown) => fetch(`${base}/api/admin/plugins/${ID}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const saved = await put({ radius: 12, apiKey: 'secret-value' });
  assert.equal(saved.status, 200);
  const view = await json(saved);
  assert.equal(view.values.apiKey, '');
  assert.equal(view.values.radius, 12);
  assert.deepEqual(view.secretsSet, { apiKey: true });

  const read = await json(await fetch(`${base}/api/admin/plugins/${ID}/settings`));
  assert.equal(read.values.apiKey, '', 'the value never leaves the server');
  assert.equal(JSON.stringify(read).includes('secret-value'), false);

  await put({ apiKey: '' });
  assert.equal(h.runtime.settings(ID).secretsSet.apiKey, true, 'a blank keeps it');
  await put({ apiKey: null });
  assert.equal(h.runtime.settings(ID).secretsSet.apiKey, false, 'null clears it');

  const bad = await put({ radius: 99 });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /at most 50/);
});

test('the logs endpoint returns what the plugin has recorded', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, server: "export default { activate(ctx) { ctx.log.warn('hello from the plugin'); } };" }));
  const logs = await json(await fetch(`${base}/api/admin/plugins/${ID}/logs`));
  assert.ok(logs.logs.some((e: { message: string; level: string }) => e.message === 'hello from the plugin' && e.level === 'warn'));
});

test('the web list needs no sign-in and names only active plugins with a web entry', async () => {
  const { h } = setup();
  const admin = await serve(h);
  const visitor = await serve(h, { user: null });
  await uploadPackage(admin, pluginPackage({ id: ID, web: true }));
  await uploadPackage(admin, pluginPackage({ id: 'media.test.other' }));
  const list = await json(await fetch(`${visitor}/api/plugins-web`));
  assert.deepEqual(list, [{ id: ID, version: '1.0.0', name: 'Demo', web: `/plugins/${ID}/1.0.0/web.js` }]);
});

test('an installed web file is served same-origin, cached as immutable, and marked nosniff', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, web: true }));
  const res = await fetch(`${base}/plugins/${ID}/1.0.0/web.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
});

test('the static route refuses traversal, the data folder, the manifest, the server file, versions not installed, and other file types', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, web: true }));
  const dataFile = path.join(h.runtime.store.dataDir(ID), 'plugin.db');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, 'secret rows');

  const cases = [
    `/plugins/${ID}/1.0.0/../../data/plugin.db`,
    `/plugins/${ID}/1.0.0/%2e%2e/%2e%2e/data/plugin.db`,
    `/plugins/${ID}/1.0.0/..%2f..%2fdata%2fplugin.db`,
    `/plugins/${ID}/data/plugin.db`,
    `/plugins/${ID}/9.9.9/web.js`,
    `/plugins/${ID}/1.0.0/.env`,
    `/plugins/${ID}/1.0.0/server.exe`,
    `/plugins/${ID}/1.0.0/plugin.json`,
    `/plugins/${ID}/1.0.0/server.js`,
  ];
  for (const p of cases) {
    const res = await rawGet(base, p);
    assert.equal(res.status, 404, `${p} should be refused`);
    assert.ok(!res.body.includes('secret rows'), `${p} must not leak the data file`);
  }

  assert.equal((await rawGet(base, `/plugins/${ID}/1.0.0/web.js`)).status, 200);
});

test('a plugin removed from the admin page is no longer served', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, web: true }));
  await fetch(`${base}/api/admin/plugins/${ID}?keepData=1`, { method: 'DELETE' });
  assert.equal((await fetch(`${base}/plugins/${ID}/1.0.0/web.js`)).status, 404);
  assert.deepEqual(await json(await fetch(`${base}/api/plugins-web`)), []);
});

test('an upload with no package field is refused', async () => {
  const { h } = setup();
  const base = await serve(h);
  const form = new FormData();
  form.append('other', new Blob([zipOf({ 'a.txt': 'x' }) as BlobPart]), 'x.zip');
  const res = await fetch(`${base}/api/admin/plugins/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /"package" field/);
});

test('the public route serves the web bundle, the icon and the assets folder of a package, and nothing else', async () => {
  const { h } = setup();
  const base = await serve(h);
  const zip = pluginPackage({
    id: ID,
    web: true,
    icon: 'icon.png',
    extraFiles: { 'icon.png': 'png-bytes', 'assets/logo.png': 'png-bytes', 'assets/css/site.css': 'body {}', 'helper.js': 'export {};' },
  });
  assert.equal((await uploadPackage(base, zip)).status, 201);

  for (const file of ['web.js', 'icon.png', 'assets/logo.png', 'assets/css/site.css']) {
    assert.equal((await rawGet(base, `/plugins/${ID}/1.0.0/${file}`)).status, 200, file);
  }
  for (const file of ['helper.js', 'server.js', 'plugin.json']) {
    assert.equal((await rawGet(base, `/plugins/${ID}/1.0.0/${file}`)).status, 404, `${file} is not public`);
  }
});

test('a .mjs web bundle is served from the plugin folder as a JavaScript module, like a .js one', async () => {
  const { h } = setup();
  const base = await serve(h);
  const zip = pluginPackage({ id: ID, web: true, webFile: 'dist/web.mjs' });
  assert.equal((await uploadPackage(base, zip)).status, 201);
  const res = await rawGet(base, `/plugins/${ID}/1.0.0/dist/web.mjs`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /javascript/, 'the browser needs a JavaScript type to import it');
  assert.equal((await rawGet(base, `/plugins/${ID}/1.0.0/dist/web.ts`)).status, 404, 'other extensions are not served');
});

test('the public route serves only the running version: not the one before it, and nothing while the plugin is off', async () => {
  const { h } = setup();
  const base = await serve(h);
  await uploadPackage(base, pluginPackage({ id: ID, version: '1.0.0', web: true }));
  await uploadPackage(base, pluginPackage({ id: ID, version: '2.0.0', web: true }));
  const bundle = async (version: string) => (await rawGet(base, `/plugins/${ID}/${version}/web.js`)).status;

  assert.equal(await bundle('2.0.0'), 200);
  assert.equal(await bundle('1.0.0'), 404, 'the previous version is still on disk, but not served');
  await fetch(`${base}/api/admin/plugins/${ID}/disable`, { method: 'POST' });
  assert.equal(await bundle('2.0.0'), 404, 'a plugin that is off serves nothing');
  await fetch(`${base}/api/admin/plugins/${ID}/enable`, { method: 'POST' });
  assert.equal(await bundle('2.0.0'), 200);
});
