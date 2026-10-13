import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The engine's database is a module singleton: give this file its own before anything loads it.
process.env.EVENT_SCOUT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photoscout-areas-'));

const { createDb } = await import('../src/db.js');
const { getSettings: appSettings, saveSettings: saveApp, DEFAULT_SETTINGS: APP_DEFAULTS } = await import('../src/settings.js');
const { getSettings, saveSettings } = await import('../src/events/db.js');
const { DEFAULT_SETTINGS } = await import('../src/events/sources/types.js');
const { engineAreaFields, importEngineAreas, startAreas, syncEngineAreas } = await import('../src/events/areas.js');

const home = { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100, events: true, busy: false };
const noLookup = async () => { throw new Error('should not geocode'); };

function fresh(areas: typeof APP_DEFAULTS.areas = []) {
  const db = createDb(':memory:');
  saveApp(db, { ...APP_DEFAULTS, home, areas });
  saveSettings({ ...DEFAULT_SETTINGS });
  return db;
}

test('an old event-scout database brings its city, areas and density areas into the list', async () => {
  const db = fresh();
  saveSettings({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85, // the home, a hair off
    eventAreas: [{ name: 'Orange NSW', lat: -33.284, lng: 149.101, radiusKm: 30 }, { name: 'Penrith' }],
    densityEnabled: true,
    densityAreas: [{ name: 'Mount Panorama', lat: -33.5, lng: 149.5, radiusKm: 3 }, { name: 'orange nsw', lat: -33.284, lng: 149.101, cellMeters: 80 }],
    eventTopics: ['motorsport'], // an engine-only field of the kind that must survive
  });

  const seen: string[] = [];
  const lookup = async (name: string) => { seen.push(name); return [{ displayName: 'Penrith, NSW, Australia', lat: -33.751, lng: 150.694, kind: 'place:city' }]; };
  const { imported, complete } = await importEngineAreas(db, lookup);

  assert.equal(complete, true);
  assert.deepEqual(seen, ['Bathurst', 'Penrith'], 'the home, for its country, then only the one with no coordinates');
  assert.deepEqual(imported, ['Orange NSW', 'Penrith', 'Mount Panorama']);
  const now = appSettings(db);
  assert.equal(now.home.name, 'Bathurst', 'the city was already home; it is not added again');
  assert.deepEqual(now.areas.map((a) => [a.name, a.radiusKm, a.events, a.busy]), [
    ['Orange NSW', 30, true, true], // a density area on the same place switches busy on
    ['Penrith', 85, true, false], // no radius of its own: the engine's default one
    ['Mount Panorama', 3, false, true], // density only
  ]);

  // Writing the list in then reproduces what the engine had, and keeps the grid tuning and the engine-only fields.
  syncEngineAreas(now);
  const eng = getSettings();
  assert.deepEqual(eng.eventTopics, ['motorsport']);
  assert.deepEqual(eng.eventAreas.map((a) => a.name), ['Orange NSW', 'Penrith']);
  assert.deepEqual(eng.densityAreas.map((a) => a.name), ['Orange NSW', 'Mount Panorama']);
  assert.equal(eng.areasManaged, true);
});

test('areas the list already has are not imported again, by name or by place', async () => {
  const db = fresh([{ name: 'Orange', lat: -33.284, lng: 149.101, radiusKm: 30, events: true, busy: false }]);
  saveSettings({
    ...DEFAULT_SETTINGS,
    city: 'bathurst', lat: null, lng: null,
    eventAreas: [{ name: 'ORANGE' }, { name: 'Orange NSW', lat: -33.285, lng: 149.1 }],
  });
  const { imported } = await importEngineAreas(db, noLookup);
  assert.deepEqual(imported, []);
  assert.equal(appSettings(db).areas.length, 1);
});

test('density that ran on the city alone makes the matching area busy', async () => {
  const db = fresh();
  saveSettings({ ...DEFAULT_SETTINGS, city: 'Bathurst', lat: -33.4166, lng: 149.5804, densityEnabled: true });
  await importEngineAreas(db, noLookup);
  assert.equal(appSettings(db).home.busy, true);
});

test('once the engine is managed, nothing is imported: an area removed here stays removed', async () => {
  const db = fresh();
  syncEngineAreas(appSettings(db));
  saveSettings({ ...getSettings(), eventAreas: [{ name: 'Orange', lat: 1, lng: 2 }] });
  const { imported } = await importEngineAreas(db, noLookup);
  assert.deepEqual(imported, []);
});

test('a lookup that fails for want of a network leaves the engine alone for the next start', async () => {
  const db = fresh();
  saveSettings({ ...DEFAULT_SETTINGS, eventAreas: [{ name: 'Penrith' }] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { complete } = await importEngineAreas(db, async () => { throw new Error('offline'); });
    assert.equal(complete, false);
  } finally {
    console.warn = warn;
  }
  // startAreas does not write over what it could not import.
  const before = getSettings();
  console.warn = () => {};
  try { await startAreas(db, async () => { throw new Error('offline'); }); } finally { console.warn = warn; }
  assert.deepEqual(getSettings().eventAreas, before.eventAreas);
  assert.equal(getSettings().areasManaged, false);
});

test('engineAreaFields: no events area leaves the engine with no city, and busy radius is capped', () => {
  const none = engineAreaFields({ home: { ...home, events: false }, areas: [] }, DEFAULT_SETTINGS);
  assert.equal(none.city, '');
  assert.equal(none.lat, null);
  const some = engineAreaFields({ home: { ...home, busy: true }, areas: [] }, DEFAULT_SETTINGS);
  assert.equal(some.densityAreas[0].radiusKm, 10);
});
