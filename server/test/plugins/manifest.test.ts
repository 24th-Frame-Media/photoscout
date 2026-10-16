import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, PluginError } from '../../src/plugins/manifest.js';

const good = {
  id: 'media.24thframe.waze',
  name: 'Waze reports',
  version: '1.2.3',
  description: 'Live reports',
  author: '24th Frame',
  category: 'feed',
  photoscout: '^1.0',
  server: 'server.js',
  web: 'web.js',
};

function rejects(json: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseManifest(json),
    (err: unknown) => err instanceof PluginError && pattern.test(err.message),
    `expected a PluginError matching ${pattern}`,
  );
}

test('a valid manifest parses, with the optional lists defaulted', () => {
  const m = parseManifest(good);
  assert.equal(m.id, 'media.24thframe.waze');
  assert.equal(m.version, '1.2.3');
  assert.deepEqual(m.permissions, []);
  assert.deepEqual(m.services, []);
  assert.deepEqual(m.settings, []);
});

test('unknown top-level fields are ignored', () => {
  const m = parseManifest({ ...good, somethingNew: { a: 1 } });
  assert.equal('somethingNew' in m, false);
});

test('a bad id is refused, with the expected shape in the message', () => {
  rejects({ ...good, id: 'waze' }, /reverse-DNS/);
  rejects({ ...good, id: 'Media.Waze' }, /reverse-DNS/);
  rejects({ ...good, id: 'media..waze' }, /reverse-DNS/);
  rejects({ ...good, id: `media.${'a'.repeat(100)}` }, /reverse-DNS/);
});

test('a bad version is refused', () => {
  rejects({ ...good, version: '1.0' }, /not a valid semver/);
  rejects({ ...good, version: 'v1.0.0' }, /not a valid semver/);
});

test('a host range the host does not meet is refused with the range named', () => {
  rejects({ ...good, photoscout: '^2.0' }, /needs PhotoScout plugin API \^2\.0/);
});

test('a range that is not semver is refused', () => {
  rejects({ ...good, photoscout: 'not a range' }, /not a valid semver range/);
});

test('package paths that escape the folder, are absolute, or are not .js are refused', () => {
  rejects({ ...good, server: '../evil.js' }, /must not contain/);
  rejects({ ...good, web: 'a/../../evil.js' }, /must not contain/);
  rejects({ ...good, server: '/abs/server.js' }, /relative path/);
  rejects({ ...good, server: '\\abs\\server.js' }, /relative path/);
  rejects({ ...good, server: 'C:/evil.js' }, /relative path/);
  rejects({ ...good, server: 'a\\b.js' }, /relative path/);
  rejects({ ...good, server: 'server.ts' }, /\.js file/);
});

test('a web bundle may be .js or .mjs; the server entry stays .js only', () => {
  assert.equal(parseManifest({ ...good, web: 'dist/web.mjs' }).web, 'dist/web.mjs');
  assert.equal(parseManifest({ ...good, web: 'web.js' }).web, 'web.js');
  rejects({ ...good, web: 'web.ts' }, /web must be a \.js or \.mjs file/);
  rejects({ ...good, server: 'server.mjs' }, /server must be a \.js file/);
  rejects({ ...good, web: '../web.mjs' }, /must not contain/);
});

test('a manifest with photoscout ^1.0 still parses on this host (the 1.1 minor adds, it does not break)', () => {
  assert.equal(parseManifest({ ...good, photoscout: '^1.0' }).photoscout, '^1.0');
});

test('an unknown permission kind is refused, and known kinds are kept', () => {
  rejects({ ...good, permissions: [{ kind: 'root' }] }, /unknown permission "root"/);
  const m = parseManifest({ ...good, permissions: [{ kind: 'network', detail: '*.waze.com' }, { kind: 'llm' }] });
  assert.deepEqual(m.permissions, [{ kind: 'network', detail: '*.waze.com' }, { kind: 'llm' }]);
});

test('a category outside the list is refused', () => {
  rejects({ ...good, category: 'games' }, /category must be one of/);
});

test('settings keys must be unique and well formed', () => {
  const field = { type: 'string', label: 'A' };
  rejects({ ...good, settings: [{ key: 'a', ...field }, { key: 'a', ...field }] }, /more than once/);
  rejects({ ...good, settings: [{ key: '1abc', ...field }] }, /must start with a letter/);
  rejects({ ...good, settings: [{ key: 'a-b', ...field }] }, /must start with a letter/);
});

test('a setting needs a known type, and a select needs choices its default is one of', () => {
  rejects({ ...good, settings: [{ key: 'a', type: 'date', label: 'A' }] }, /unknown type "date"/);
  rejects({ ...good, settings: [{ key: 'a', type: 'select', label: 'A', options: [] }] }, /non-empty options/);
  rejects(
    { ...good, settings: [{ key: 'a', type: 'select', label: 'A', default: 'x', options: [{ value: 'y', label: 'Y' }] }] },
    /default is not one of its options/,
  );
});

test('services need a name, an image and a port in range', () => {
  rejects({ ...good, services: [{ name: 'worker', image: 'x:1', port: 70000 }] }, /port must be a whole number/);
  const m = parseManifest({ ...good, services: [{ name: 'worker', image: 'x:1', port: 8080, env: { A: '1' } }] });
  assert.equal(m.services?.[0].port, 8080);
  assert.deepEqual(m.services?.[0].env, { A: '1' });
});

test('a non-object is refused', () => {
  rejects(null, /must be a JSON object/);
  rejects([], /must be a JSON object/);
});

test('a setting may not take a name that every object has, since a lookup would find it', () => {
  for (const key of ['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    rejects({ ...good, settings: [{ key, type: 'string', label: 'A' }] }, /is reserved/);
  }
});
