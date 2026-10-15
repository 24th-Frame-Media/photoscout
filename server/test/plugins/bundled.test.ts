import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bundledDirs, installBundled } from '../../src/plugins/bundled.js';
import { createPluginStore, type PluginStore } from '../../src/plugins/store.js';
import { listen, makeRuntime, pluginApp, pluginPackage, removeRoot, tempRoot, type Harness, type Listening } from './helpers.js';

/**
 * Bundled plugins: installed when missing, upgraded when newer, and never
 * against the admin's choices (an upload, a disabled plugin, a rollback).
 */

const ID = 'media.test.demo';
const scratch: string[] = [];
const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
  for (const dir of scratch.splice(0)) removeRoot(dir);
});

/** A folder with one zip per entry, as the build leaves plugins/<name>/dist. */
function bundleFolder(zips: Record<string, Uint8Array>): string {
  const dir = tempRoot();
  scratch.push(dir);
  for (const [name, bytes] of Object.entries(zips)) fs.writeFileSync(path.join(dir, name), bytes);
  return dir;
}

/** A plain store over an in-memory database, so each test can look at the rows. */
function freshStore(): { store: PluginStore; handle: DatabaseSync } {
  const handle = new DatabaseSync(':memory:');
  const root = tempRoot();
  scratch.push(root);
  return { store: createPluginStore({ handle, root }), handle };
}

test('a bundled plugin that is not installed yet is installed as a bundled copy, enabled', () => {
  const { store } = freshStore();
  const dir = bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.0.0' }) });

  const report = installBundled(dir, store);

  assert.deepEqual(report.installed, [`${ID}@1.0.0`]);
  assert.deepEqual(report.failed, []);
  const row = store.get(ID)!;
  assert.equal(row.source, 'bundled');
  assert.equal(row.activeVersion, '1.0.0');
  assert.equal(row.enabled, true);
});

test('a newer bundled version upgrades the bundled copy and keeps the old one for rollback', () => {
  const { store } = freshStore();
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.0.0' }) }), store);

  const report = installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.1.0' }) }), store);

  assert.deepEqual(report.upgraded, [`${ID}@1.1.0`]);
  const row = store.get(ID)!;
  assert.equal(row.activeVersion, '1.1.0');
  assert.equal(row.previousVersion, '1.0.0');
  assert.equal(row.source, 'bundled');
  assert.equal(store.resolveVersionDir(ID, '1.0.0') !== null, true, 'the previous version stays on disk');
});

test('an equal or older bundled version changes nothing', () => {
  const { store } = freshStore();
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.1.0' }) }), store);

  const report = installBundled(bundleFolder({ 'same.zip': pluginPackage({ id: ID, version: '1.1.0' }), 'older.zip': pluginPackage({ id: ID, version: '0.9.0' }) }), store);

  assert.deepEqual(report.upgraded, []);
  assert.deepEqual(report.kept, [], 'nothing to report on an ordinary start');
  assert.equal(store.get(ID)!.activeVersion, '1.1.0');
});

test('an id the admin installed from an upload is never overridden by a bundled copy', () => {
  const { store } = freshStore();
  store.installFromZip(pluginPackage({ id: ID, version: '1.0.0' }), { source: 'upload' });

  const report = installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '2.0.0' }) }), store);

  assert.deepEqual(report.upgraded, []);
  assert.equal(report.kept.length, 1);
  assert.match(report.kept[0].reason, /installed by an admin/);
  const row = store.get(ID)!;
  assert.equal(row.activeVersion, '1.0.0');
  assert.equal(row.source, 'upload');
});

test('a plugin the admin disabled stays disabled through a bundled upgrade', async () => {
  const h = makeRuntime();
  harnesses.push(h);
  const store = h.runtime.store;
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.0.0' }) }), store);
  await h.runtime.loadAll();
  await h.runtime.setEnabled(ID, false);

  const report = installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.1.0' }) }), store);
  await h.runtime.loadAll();

  assert.deepEqual(report.upgraded, [`${ID}@1.1.0`]);
  const row = store.get(ID)!;
  assert.equal(row.enabled, false, 'the upgrade does not switch it on');
  assert.equal(row.activeVersion, '1.1.0');
  assert.equal(h.runtime.status(ID)!.status, 'disabled');
  const s = await listen(pluginApp(h.runtime));
  servers.push(s);
  assert.equal((await fetch(`${s.base}/api/plugins/${ID}/ping`)).status, 404, 'and it is not running');
});

test('a version the admin rolled back from is not put back by the next start', () => {
  const { store } = freshStore();
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.0.0' }) }), store);
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.1.0' }) }), store);
  store.rollback(ID);

  const report = installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.1.0' }) }), store);

  assert.deepEqual(report.upgraded, []);
  assert.match(report.kept[0].reason, /rolled .* back from 1\.1\.0/);
  assert.equal(store.get(ID)!.activeVersion, '1.0.0');
});

test('a zip that is not a plugin is reported as failed, and the others still install', () => {
  const { store } = freshStore();
  const dir = bundleFolder({
    'a-broken.zip': new Uint8Array([1, 2, 3, 4]),
    'b-demo.zip': pluginPackage({ id: ID, version: '1.0.0' }),
    'notes.txt': new TextEncoder().encode('not a zip'),
  });

  const report = installBundled(dir, store);

  assert.deepEqual(report.installed, [`${ID}@1.0.0`]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].file, 'a-broken.zip');
});

test('a folder that does not exist installs nothing', () => {
  const { store } = freshStore();
  assert.deepEqual(installBundled(path.join(os.tmpdir(), 'no-such-bundled-folder-xyz'), store), { installed: [], upgraded: [], kept: [], failed: [] });
});

test('PHOTOSCOUT_BUNDLED_PLUGINS, when set, is the only folder looked in', () => {
  assert.deepEqual(bundledDirs({ PHOTOSCOUT_BUNDLED_PLUGINS: '/some/where' }, '/nowhere'), [path.resolve('/some/where')]);
});

test('by default the folders are plugins/<name>/dist and bundled-plugins/, when they exist', () => {
  const appRoot = tempRoot();
  scratch.push(appRoot);
  fs.mkdirSync(path.join(appRoot, 'plugins', 'alpha', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'plugins', 'beta'), { recursive: true }); // no dist yet: skipped
  fs.mkdirSync(path.join(appRoot, 'bundled-plugins'), { recursive: true });

  assert.deepEqual(bundledDirs({}, appRoot), [
    path.join(appRoot, 'plugins', 'alpha', 'dist'),
    path.join(appRoot, 'bundled-plugins'),
  ]);
});

test('a bundled plugin is running after startup, without any upload', async () => {
  const h = makeRuntime();
  harnesses.push(h);
  installBundled(bundleFolder({ 'demo.zip': pluginPackage({ id: ID, version: '1.0.0' }) }), h.runtime.store);

  await h.runtime.loadAll();

  assert.equal(h.runtime.status(ID)!.status, 'active');
  assert.equal(h.runtime.status(ID)!.source, 'bundled');
  const s = await listen(pluginApp(h.runtime));
  servers.push(s);
  const ping = await fetch(`${s.base}/api/plugins/${ID}/ping`);
  assert.equal(ping.status, 200);
});
