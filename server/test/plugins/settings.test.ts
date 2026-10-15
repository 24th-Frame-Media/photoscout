import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings, maskCredentials, mergeSettings, redactedSettings } from '../../src/plugins/settings.js';
import { PluginError } from '../../src/plugins/manifest.js';
import type { SettingField } from '../../src/plugins/types.js';

const fields: SettingField[] = [
  { key: 'city', type: 'string', label: 'City', default: 'Sydney', required: true },
  { key: 'apiKey', type: 'secret', label: 'API key' },
  { key: 'radius', type: 'number', label: 'Radius', min: 1, max: 50, default: 10 },
  { key: 'site', type: 'url', label: 'Site' },
  { key: 'live', type: 'boolean', label: 'Live', default: false },
  { key: 'mode', type: 'select', label: 'Mode', default: 'fast', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }] },
];

test('the plugin sees the stored values over the defaults', () => {
  assert.deepEqual(effectiveSettings(fields, { city: 'Bathurst' }), { city: 'Bathurst', radius: 10, live: false, mode: 'fast' });
});

test('secrets are blanked for the admin page, with only whether one is set', () => {
  const view = redactedSettings(fields, { apiKey: 'abc', city: 'X' });
  assert.equal(view.values.apiKey, '');
  assert.deepEqual(view.secretsSet, { apiKey: true });
  assert.equal(view.values.city, 'X');
  assert.equal(redactedSettings(fields, {}).secretsSet.apiKey, false);
});

test('a blank secret keeps the stored one, a null clears it, and a text replaces it', () => {
  const stored = { apiKey: 'old' };
  assert.equal(mergeSettings(fields, stored, { apiKey: '' }).apiKey, 'old');
  assert.equal(mergeSettings(fields, stored, {}).apiKey, 'old');
  assert.equal(mergeSettings(fields, stored, { apiKey: null }).apiKey, '');
  assert.equal(mergeSettings(fields, stored, { apiKey: '  new  ' }).apiKey, 'new');
});

test('fields the save leaves out keep their stored values, and unknown keys are dropped', () => {
  const next = mergeSettings(fields, { city: 'Bathurst', radius: 5 }, { live: true, bogus: 'x' });
  assert.equal(next.city, 'Bathurst');
  assert.equal(next.radius, 5);
  assert.equal(next.live, true);
  assert.equal('bogus' in next, false);
});

test('numbers are checked against their range', () => {
  assert.equal(mergeSettings(fields, {}, { radius: '7' }).radius, 7);
  assert.throws(() => mergeSettings(fields, {}, { radius: 0 }), (err: unknown) => err instanceof PluginError && /at least 1/.test(err.message));
  assert.throws(() => mergeSettings(fields, {}, { radius: 51 }), (err: unknown) => err instanceof PluginError && /at most 50/.test(err.message));
  assert.throws(() => mergeSettings(fields, {}, { radius: 'lots' }), PluginError);
});

test('a select only takes one of its choices, a boolean only true or false, a url only http(s)', () => {
  assert.throws(() => mergeSettings(fields, {}, { mode: 'warp' }), PluginError);
  assert.throws(() => mergeSettings(fields, {}, { live: 'yes' }), PluginError);
  assert.throws(() => mergeSettings(fields, {}, { site: 'javascript:alert(1)' }), PluginError);
  assert.equal(mergeSettings(fields, {}, { site: 'https://example.com' }).site, 'https://example.com');
});

test('a required field cannot be saved blank', () => {
  assert.throws(() => mergeSettings(fields, {}, { city: '   ' }), (err: unknown) => err instanceof PluginError && /City is required/.test(err.message));
});

test('companion service addresses are kept, cleared and checked', () => {
  const kept = mergeSettings(fields, {}, { 'service:worker:url': 'http://worker.internal:8080' });
  assert.equal(kept['service:worker:url'], 'http://worker.internal:8080');
  const cleared = mergeSettings(fields, kept, { 'service:worker:url': '' });
  assert.equal('service:worker:url' in cleared, false);
  assert.throws(() => mergeSettings(fields, {}, { 'service:worker:url': 'ftp://x' }), PluginError);
});

test('the admin page sees only the keys the manifest declares; a key left over from a removed field is not shown', () => {
  const view = redactedSettings(fields, { city: 'X', gone: 'stale', apiKey: 'abc' });
  assert.equal(view.values.city, 'X');
  assert.equal('gone' in view.values, false);
  assert.equal(view.values.apiKey, '');
});

test('a service address is shown for a declared service only, with its user:password taken out', () => {
  const stored = {
    'service:worker:url': 'http://user:hunter2@worker.internal:8080/api',
    'service:old:url': 'http://admin:letmein@old.internal',
  };
  const view = redactedSettings(fields, stored, ['worker']);
  assert.equal(view.values['service:worker:url'], 'http://***@worker.internal:8080/api');
  assert.equal('service:old:url' in view.values, false, 'a service the manifest no longer declares');
  assert.equal(JSON.stringify(view).includes('hunter2'), false);
  assert.equal(maskCredentials('https://worker.example/x'), 'https://worker.example/x', 'no credentials, no change');
});

test('a field named like an object property is read as its own value, never an inherited one', () => {
  const odd: SettingField[] = [
    { key: 'valueOf', type: 'string', label: 'Odd', required: true },
    { key: 'constructor', type: 'secret', label: 'Other' },
  ];
  assert.throws(() => mergeSettings(odd, {}, {}), (err: unknown) => err instanceof PluginError && /Odd is required/.test(err.message));
  assert.equal(redactedSettings(odd, {}).secretsSet.constructor, false, 'a blank secret is not set, even though Object is a function');
  assert.equal(Object.hasOwn(mergeSettings(odd, {}, { valueOf: 'x' }), 'valueOf'), true);
});
