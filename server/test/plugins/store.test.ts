import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import { createPluginStore, type PluginStore } from '../../src/plugins/store.js';
import { PluginError } from '../../src/plugins/manifest.js';
import { pluginPackage, removeRoot, tempRoot, zipOf } from './helpers.js';

const roots: string[] = [];
function fresh(): { store: PluginStore; root: string } {
  const root = tempRoot();
  roots.push(root);
  return { store: createPluginStore({ handle: new DatabaseSync(':memory:'), root }), root };
}
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root);
});

function manifestJson(id: string, version: string): string {
  return JSON.stringify({
    id,
    name: 'Demo',
    version,
    description: 'd',
    author: 'a',
    category: 'tools',
    photoscout: '^1.0',
    server: 'server.js',
  });
}

function expectPluginError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof PluginError && pattern.test(err.message), `expected ${pattern}`);
}

// --- archives -----------------------------------------------------------------

const OK_JSON = manifestJson('media.test.demo', '1.0.0');

test('a package with a path that climbs out of the folder is refused', () => {
  const { store } = fresh();
  const zip = zipOf({ 'plugin.json': OK_JSON, 'server.js': 'export default {};', '../evil.js': 'x' });
  expectPluginError(() => store.installFromZip(zip, { source: 'upload' }), /Unsafe path/);
});

test('a package with an absolute path is refused', () => {
  const { store } = fresh();
  const zip = zipOf({ 'plugin.json': OK_JSON, 'server.js': 'export default {};', '/etc/passwd': 'x' });
  expectPluginError(() => store.installFromZip(zip, { source: 'upload' }), /Unsafe path/);
});

test('a package with a backslash in a name is refused', () => {
  const { store } = fresh();
  const zip = zipOf({ 'plugin.json': OK_JSON, 'server.js': 'export default {};', 'a\\b.js': 'x' });
  expectPluginError(() => store.installFromZip(zip, { source: 'upload' }), /Unsafe path/);
});

test('a symbolic link in the package is refused', () => {
  const { store } = fresh();
  const linkAttrs = (0o120777 << 16) >>> 0; // Unix mode S_IFLNK, as zip tools record a symlink
  const zip = zipSync({
    'plugin.json': strToU8(OK_JSON),
    'server.js': strToU8('export default {};'),
    'link.js': [strToU8('server.js'), { attrs: linkAttrs }],
  });
  expectPluginError(() => store.installFromZip(zip, { source: 'upload' }), /symbolic link/);
});

test('a package that unpacks to more than 50 MB is refused', () => {
  const { store } = fresh();
  // Zeros compress to almost nothing, so the zip is small and only the unpacked size is over the limit.
  const big = new Uint8Array(51 * 1024 * 1024);
  const zip = zipSync({ 'plugin.json': strToU8(OK_JSON), 'big.bin': big });
  assert.ok(zip.byteLength < 1024 * 1024, 'the test needs a zip under the package limit');
  expectPluginError(() => store.installFromZip(zip, { source: 'upload' }), /more than 50 MB/);
});

test('a package with more than 2000 files is refused', () => {
  const { store } = fresh();
  const files: Record<string, string> = { 'plugin.json': OK_JSON, 'server.js': 'export default {};' };
  for (let i = 0; i < 2000; i++) files[`f${i}.txt`] = 'x';
  expectPluginError(() => store.installFromZip(zipOf(files), { source: 'upload' }), /more than 2000 files/);
});

test('a package without plugin.json is refused', () => {
  const { store } = fresh();
  expectPluginError(() => store.installFromZip(zipOf({ 'server.js': 'export default {};' }), { source: 'upload' }), /no plugin.json/);
});

test('a package that names a file it does not contain is refused', () => {
  const { store } = fresh();
  expectPluginError(() => store.installFromZip(zipOf({ 'plugin.json': OK_JSON }), { source: 'upload' }), /server.js is named in plugin.json but is not in the package/);
});

test('bytes that are not a zip are refused', () => {
  const { store } = fresh();
  expectPluginError(() => store.installFromZip(strToU8('hello, this is not a zip file at all'), { source: 'upload' }), /not a zip file/);
});

test('a package zipped inside one folder is accepted, with the folder stripped', () => {
  const { store } = fresh();
  const zip = zipOf({ 'demo/plugin.json': OK_JSON, 'demo/server.js': 'export default {};' });
  const result = store.installFromZip(zip, { source: 'upload' });
  assert.equal(result.manifest.id, 'media.test.demo');
  assert.ok(fs.existsSync(path.join(store.versionDir('media.test.demo', '1.0.0'), 'server.js')));
});

// --- versions -----------------------------------------------------------------

test('installs keep the active and previous version, and prune drops the rest', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  let row = store.get(id)!;
  assert.equal(row.activeVersion, '1.0.0');
  assert.equal(row.previousVersion, null);
  assert.equal(row.enabled, true);

  const second = store.installFromZip(pluginPackage({ version: '2.0.0' }), { source: 'upload' });
  assert.equal(second.prior?.activeVersion, '1.0.0');
  row = store.get(id)!;
  assert.equal(row.activeVersion, '2.0.0');
  assert.equal(row.previousVersion, '1.0.0');

  store.installFromZip(pluginPackage({ version: '3.0.0' }), { source: 'upload' });
  store.prune(id);
  assert.equal(fs.existsSync(store.versionDir(id, '1.0.0')), false, '1.0.0 is no longer the previous version');
  assert.equal(fs.existsSync(store.versionDir(id, '2.0.0')), true);
  assert.equal(fs.existsSync(store.versionDir(id, '3.0.0')), true);
});

test('re-installing the active or the previous version is a conflict', () => {
  const { store } = fresh();
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  store.installFromZip(pluginPackage({ version: '2.0.0' }), { source: 'upload' });
  expectPluginError(() => store.installFromZip(pluginPackage({ version: '2.0.0' }), { source: 'upload' }), /already installed/);
  expectPluginError(() => store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' }), /already installed/);
});

test('rollback swaps the active and previous versions, and refuses when there is none', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  expectPluginError(() => store.rollback(id), /no earlier version/);
  store.installFromZip(pluginPackage({ version: '2.0.0' }), { source: 'upload' });
  const row = store.rollback(id);
  assert.equal(row.activeVersion, '1.0.0');
  assert.equal(row.previousVersion, '2.0.0');
  assert.ok(store.resolveVersionDir(id, '2.0.0'), 'the version rolled away from stays available to roll forward');
  assert.equal(store.resolveVersionDir(id, '9.9.9'), null);
});

test('a failed install is reverted to the row it replaced, and its folder goes', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  const { prior, version } = store.installFromZip(pluginPackage({ version: '2.0.0' }), { source: 'upload' });
  store.revertInstall(id, prior, version);
  const row = store.get(id)!;
  assert.equal(row.activeVersion, '1.0.0');
  assert.equal(row.previousVersion, null);
  assert.equal(fs.existsSync(store.versionDir(id, '2.0.0')), false);
});

test('a first install that fails is removed entirely', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  const { prior, version } = store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  store.revertInstall(id, prior, version);
  assert.equal(store.get(id), null);
  assert.equal(fs.existsSync(store.versionDir(id, '1.0.0')), false);
});

test('uninstall keeps the data folder only when asked to', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  fs.mkdirSync(store.dataDir(id), { recursive: true });
  fs.writeFileSync(path.join(store.dataDir(id), 'keep.txt'), 'mine');

  store.uninstall(id, { keepData: true });
  assert.equal(store.get(id), null);
  assert.equal(fs.existsSync(path.join(store.dataDir(id), 'keep.txt')), true);
  assert.equal(fs.existsSync(store.versionDir(id, '1.0.0')), false);

  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  store.uninstall(id, { keepData: false });
  assert.equal(fs.existsSync(path.join(store.root, id)), false);
});

test('settings and enabled state are stored on the row', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  store.installFromZip(pluginPackage({ version: '1.0.0' }), { source: 'upload' });
  store.saveSettings(id, { city: 'Sydney' });
  store.setEnabled(id, false);
  const row = store.get(id)!;
  assert.deepEqual(row.settings, { city: 'Sydney' });
  assert.equal(row.enabled, false);
});

test('a directory install copies the folder in', () => {
  const { store } = fresh();
  const src = tempRoot();
  roots.push(src);
  fs.writeFileSync(path.join(src, 'plugin.json'), OK_JSON);
  fs.writeFileSync(path.join(src, 'server.js'), 'export default {};');
  const result = store.installFromDir(src, { source: 'dev' });
  assert.equal(result.manifest.version, '1.0.0');
  assert.equal(store.get('media.test.demo')!.source, 'dev');
  assert.ok(fs.existsSync(path.join(store.versionDir('media.test.demo', '1.0.0'), 'plugin.json')));
});

test('an invalid id never reaches the disk', () => {
  const { store } = fresh();
  expectPluginError(() => store.versionDir('../escape', '1.0.0'), /not a valid plugin id/);
  expectPluginError(() => store.versionDir('media.test.demo', '../1.0.0'), /not a valid version/);
});

test('an upgrade that turns a secret into a plain field drops its value; a failed upgrade gives it back', () => {
  const { store } = fresh();
  const id = 'media.test.demo';
  const fieldsBefore = [
    { key: 'apiKey', type: 'secret', label: 'Key' },
    { key: 'city', type: 'string', label: 'City' },
  ];
  store.installFromZip(pluginPackage({ version: '1.0.0', settings: fieldsBefore }), { source: 'upload' });
  store.saveSettings(id, { apiKey: 'abc', city: 'Bathurst' });

  const plain = [
    { key: 'apiKey', type: 'string', label: 'Key' },
    { key: 'city', type: 'string', label: 'City' },
  ];
  const upgrade = store.installFromZip(pluginPackage({ version: '2.0.0', settings: plain }), { source: 'upload' });
  assert.equal('apiKey' in store.get(id)!.settings, false, 'the old secret is not shown as a plain field');
  assert.equal(store.get(id)!.settings.city, 'Bathurst', 'the other values stay');

  store.revertInstall(id, upgrade.prior, upgrade.version);
  assert.equal(store.get(id)!.settings.apiKey, 'abc', 'a failed upgrade puts the settings back');
});
