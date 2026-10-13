import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { applySettingsUpdate, getSettings, publicSettings, memberSettings } from '../src/settings.js';

test('settings: instance settings store home, areas, remotes, and cors; drops unknown properties', () => {
  const db = createDb(':memory:');
  const update = {
    home: { name: 'Sydney', lat: -33.8688, lng: 151.2093, radiusKm: 50 },
    areas: [{ name: 'Newcastle', lat: -32.9283, lng: 151.7817, radiusKm: 30 }],
    allowPrivateRemotes: true,
    corsOrigins: ['https://example.com'],
    unknownProp: 'discarded',
    tfnswApiKey: 'must-not-be-stored',
  };
  const { settings, areasChanged } = applySettingsUpdate(db, update);
  assert.equal(areasChanged, true);
  assert.equal(settings.home.name, 'Sydney');
  assert.equal(settings.areas.length, 1);
  assert.equal(settings.areas[0].name, 'Newcastle');
  assert.equal(settings.allowPrivateRemotes, true);
  assert.deepEqual(settings.corsOrigins, ['https://example.com']);
  assert.ok(!('unknownProp' in settings));
  assert.ok(!('tfnswApiKey' in settings));

  const pub = publicSettings(getSettings(db));
  assert.equal(pub.home.name, 'Sydney');
  assert.ok(!('tfnswApiKey' in pub));
  assert.ok(!('tfnswApiKeySet' in pub));

  const member = memberSettings(getSettings(db));
  assert.deepEqual(Object.keys(member).sort(), ['areas', 'home']);
});

test('settings: cleanSettingsBody rejects invalid area shapes and bounds', () => {
  const db = createDb(':memory:');
  const bad = {
    home: { name: 'Invalid', lat: 999, lng: 0, radiusKm: 10 },
  };
  const { settings } = applySettingsUpdate(db, bad);
  // Default home is preserved since bad home was rejected
  assert.equal(settings.home.name, 'Bathurst');
});

test('settings: per-area topics and hidden categories are trimmed, deduped and dropped when empty', () => {
  const db = createDb(':memory:');
  const a = { name: 'Penrith', lat: -33.75, lng: 150.69, radiusKm: 25, events: true, busy: false };
  const { settings } = applySettingsUpdate(db, {
    areas: [{ ...a, topics: [' car ', 'car', '', 5], hiddenCategories: ['Music'] }, { ...a, name: 'B', topics: [], hiddenCategories: 'x' }],
  });
  assert.deepEqual(settings.areas[0].topics, ['car']);
  assert.deepEqual(settings.areas[0].hiddenCategories, ['Music']);
  assert.equal('topics' in settings.areas[1], false);
  assert.equal('hiddenCategories' in settings.areas[1], false);
});
