import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESTART_MESSAGE,
  SAFE_MODE_MESSAGE,
  categoryLabel,
  changedSettings,
  coerceSettingValue,
  draftFor,
  iconUrl,
  newestFirst,
  originTag,
  permissionLines,
  permissionWords,
  pluginFileUrl,
  rollbackLabel,
  servicesLine,
  statusBadge,
  type SettingsEdits,
} from '../src/settings/pluginsFormat.js';
import type { PluginSettingField } from '../src/settings/pluginsApi.js';

test('the two banners say what the spec asks, word for word', () => {
  assert.equal(SAFE_MODE_MESSAGE, 'Safe mode: all plugins are off. Remove PHOTOSCOUT_SAFE_MODE to turn them back on.');
  assert.equal(RESTART_MESSAGE, 'Several plugins were updated since the last restart. Restart PhotoScout when convenient to free memory.');
});

test('each permission kind is described in plain words, and the network one names its host', () => {
  assert.equal(permissionWords({ kind: 'network', detail: 'radio.garden' }), 'Connects to radio.garden');
  assert.equal(permissionWords({ kind: 'network' }), 'Connects to other websites');
  assert.equal(permissionWords({ kind: 'secrets' }), 'Stores passwords or keys');
  assert.equal(permissionWords({ kind: 'realtime' }), 'Sends live updates');
  assert.equal(permissionWords({ kind: 'llm' }), 'Uses AI models');
  assert.equal(permissionWords({ kind: 'tasks' }), 'Runs scheduled tasks');
  assert.equal(permissionWords({ kind: 'storage' }), 'Stores its own data');
});

test('permission lines are de-duplicated and keep the declared order', () => {
  assert.deepEqual(
    permissionLines([{ kind: 'network', detail: 'a.example' }, { kind: 'tasks' }, { kind: 'network', detail: 'a.example' }, { kind: 'network', detail: 'b.example' }]),
    ['Connects to a.example', 'Runs scheduled tasks', 'Connects to b.example'],
  );
  assert.deepEqual(permissionLines([]), []);
});

test('a companion service is named with its image; no services means no note', () => {
  assert.equal(servicesLine([]), null);
  assert.equal(servicesLine([{ name: 'emulator', image: 'ghcr.io/example/worker:1.2.0', port: 8088 }]), 'Needs a companion service: emulator (ghcr.io/example/worker:1.2.0)');
});

test('the status badge: Active, Error, Off when switched off, and Not running when on but not started', () => {
  assert.deepEqual(statusBadge({ status: 'active', enabled: true }), { label: 'Active', tone: 'ok' });
  assert.deepEqual(statusBadge({ status: 'error', enabled: true }), { label: 'Error', tone: 'error' });
  assert.deepEqual(statusBadge({ status: 'disabled', enabled: false }), { label: 'Off', tone: 'off' });
  assert.deepEqual(statusBadge({ status: 'inactive', enabled: false }), { label: 'Off', tone: 'off' });
  assert.deepEqual(statusBadge({ status: 'inactive', enabled: true }), { label: 'Not running', tone: 'muted' });
});

test('the origin tag: bundled and dev are tagged, an uploaded plugin is not', () => {
  assert.equal(originTag('bundled')?.label, 'Bundled');
  assert.equal(originTag('dev')?.label, 'Dev');
  assert.equal(originTag('upload'), null);
});

test('rollback is offered only when there is an earlier version', () => {
  assert.equal(rollbackLabel(null), null);
  assert.equal(rollbackLabel('1.0.0'), 'Roll back to 1.0.0');
});

test('icons and files are served from the version folder, one encoded segment at a time', () => {
  assert.equal(pluginFileUrl('media.24thframe.radio-garden', '1.0.0', 'assets/icon.png'), '/plugins/media.24thframe.radio-garden/1.0.0/assets/icon.png');
  assert.equal(iconUrl({ id: 'media.x', version: '2.0.0', icon: 'icon.svg' }), '/plugins/media.x/2.0.0/icon.svg');
  assert.equal(iconUrl({ id: 'media.x', version: '2.0.0', icon: null }), null);
});

test('categories read as words, and an unknown category still shows', () => {
  assert.equal(categoryLabel('map'), 'Map layer');
  assert.equal(categoryLabel(null), 'Plugin');
  assert.equal(categoryLabel('weather'), 'weather');
});

test('the log is shown newest first, without changing the order it came in', () => {
  const log = [
    { at: '2026-10-15T10:00:00Z', level: 'info' as const, message: 'first' },
    { at: '2026-10-15T10:05:00Z', level: 'error' as const, message: 'second' },
  ];
  assert.deepEqual(newestFirst(log).map((e) => e.message), ['second', 'first']);
  assert.deepEqual(log.map((e) => e.message), ['first', 'second']);
});

const number: PluginSettingField = { key: 'radius', type: 'number', label: 'Radius', min: 1, max: 50, required: true };
const text: PluginSettingField = { key: 'name', type: 'string', label: 'Name' };
const url: PluginSettingField = { key: 'home', type: 'url', label: 'Home' };
const flag: PluginSettingField = { key: 'on', type: 'boolean', label: 'On' };
const pick: PluginSettingField = { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };
const secret: PluginSettingField = { key: 'token', type: 'secret', label: 'Token' };

test('the starting value of each input: a stored value, or blank', () => {
  assert.equal(draftFor(number, 12), '12');
  assert.equal(draftFor(number, undefined), '');
  assert.equal(draftFor(flag, true), true);
  assert.equal(draftFor(flag, undefined), false);
  assert.equal(draftFor(secret, 'anything'), '', 'a secret is never shown back');
});

test('numbers are checked against their range; a bad or missing one says why', () => {
  assert.deepEqual(coerceSettingValue(number, '12'), { ok: true, value: 12 });
  assert.deepEqual(coerceSettingValue(number, ' 7.5 '), { ok: true, value: 7.5 });
  assert.deepEqual(coerceSettingValue(number, ''), { ok: false, error: 'Radius is required' });
  assert.deepEqual(coerceSettingValue(number, 'abc'), { ok: false, error: 'Radius needs a number' });
  assert.deepEqual(coerceSettingValue(number, '0'), { ok: false, error: 'Radius must be at least 1' });
  assert.deepEqual(coerceSettingValue(number, '51'), { ok: false, error: 'Radius must be at most 50' });
});

test('an address must be http or https, and an empty optional one is allowed', () => {
  assert.deepEqual(coerceSettingValue(url, 'https://example.org/x'), { ok: true, value: 'https://example.org/x' });
  assert.equal(coerceSettingValue(url, 'ftp://example.org').ok, false);
  assert.equal(coerceSettingValue(url, 'not a url').ok, false);
  assert.deepEqual(coerceSettingValue(url, '  '), { ok: true, value: '' });
});

test('a select only takes one of its choices, and a required text cannot be blank', () => {
  assert.deepEqual(coerceSettingValue(pick, 'b'), { ok: true, value: 'b' });
  assert.equal(coerceSettingValue(pick, 'c').ok, false);
  assert.deepEqual(coerceSettingValue({ ...text, required: true }, '  '), { ok: false, error: 'Name is required' });
  assert.deepEqual(coerceSettingValue(text, '  hi '), { ok: true, value: 'hi' });
});

const blank = (): SettingsEdits => ({ values: {}, secretTyped: {}, secretRemoved: {}, current: {} });

test('nothing touched sends nothing, and an untouched field with no stored value is not sent as blank', () => {
  const fields = [number, text, flag, pick, secret];
  const edits = blank();
  edits.current = { radius: 10, name: 'x', on: false, mode: 'a' };
  for (const f of fields) edits.values[f.key] = draftFor(f, edits.current[f.key]);
  assert.deepEqual(changedSettings(fields, edits), { payload: {}, errors: [] });

  const fresh = blank();
  fresh.current = {};
  fresh.values = { name: '' };
  assert.deepEqual(changedSettings([text], fresh), { payload: {}, errors: [] });
});

test('only the changed fields are sent, checked first', () => {
  const edits = blank();
  edits.current = { radius: 10, name: 'x', on: false };
  edits.values = { radius: '25', name: 'x', on: true };
  assert.deepEqual(changedSettings([number, text, flag], edits), { payload: { radius: 25, on: true }, errors: [] });

  edits.values = { radius: '99', name: 'y', on: false };
  assert.deepEqual(changedSettings([number, text, flag], edits), { payload: { name: 'y' }, errors: ['Radius must be at most 50'] });
});

test('a secret: typed is sent, blank keeps the stored one (left out), and Remove sends null', () => {
  const typed = blank();
  typed.secretTyped = { token: '  new-key ' };
  assert.deepEqual(changedSettings([secret], typed).payload, { token: 'new-key' });

  const untouched = blank();
  untouched.secretTyped = { token: '   ' };
  assert.deepEqual(changedSettings([secret], untouched).payload, {}, 'a blank secret keeps what is stored');

  const removed = blank();
  removed.secretRemoved = { token: true };
  assert.deepEqual(changedSettings([secret], removed).payload, { token: null });
});
