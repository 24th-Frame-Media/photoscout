import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDb } from '../src/db.js';
import { importFeatureCollection, ImportError, MAX_IMPORT_FEATURES, type ShareBundle } from '../src/share.js';

const feature = (kind: 'place' | 'spot', props: Record<string, unknown> = {}, coordinates: unknown = [149.5, -33.4]) =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { kind, id: 'x', name: 'N', ...props } }) as any;
const bundle = (...features: unknown[]): ShareBundle => ({ type: 'FeatureCollection', features: features as any });
const count = (db: ReturnType<typeof createDb>, table: string): number =>
  (db.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('import: a source ref owned by someone else makes a new row and leaves theirs alone', () => {
  const db = createDb(':memory:');
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  importFeatureCollection(db, bundle(
    feature('spot', { name: 'A spot', notes: 'mine', source: 'osm', sourceRef: 'node/1' }),
    feature('place', { name: 'A place', source: 'osm', sourceRef: 'node/2' }),
  ), a);
  const before = db.handle.prepare('SELECT * FROM spots').all();
  const r = importFeatureCollection(db, bundle(
    feature('spot', { name: 'Hijack', notes: 'B', source: 'osm', sourceRef: 'node/1' }, [10, 10]),
    feature('place', { name: 'Hijack', source: 'osm', sourceRef: 'node/2' }),
  ), b);
  assert.deepEqual(r, { places: 1, spots: 1 });
  assert.equal(count(db, 'spots'), 2);
  assert.equal(count(db, 'places'), 2);
  assert.deepEqual(db.handle.prepare('SELECT * FROM spots WHERE owner_id = ?').all(a), before);
  assert.equal((db.handle.prepare('SELECT name FROM places WHERE owner_id = ?').get(a) as any).name, 'A place');
  // Their own re-import still updates in place.
  importFeatureCollection(db, bundle(feature('spot', { name: 'Renamed', source: 'osm', sourceRef: 'node/1' })), a);
  assert.equal(count(db, 'spots'), 2);
  assert.equal((db.handle.prepare('SELECT name FROM spots WHERE owner_id = ?').get(a) as any).name, 'Renamed');
});

test('import: a bad feature is refused and the good ones before it are not written', () => {
  const db = createDb(':memory:');
  const owner = crypto.randomUUID();
  const bad: [string, unknown][] = [
    ['not a point', { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { kind: 'spot', name: 'x' } }],
    ['lat out of range', feature('spot', {}, [10, 91])],
    ['lng out of range', feature('spot', {}, [181, 10])],
    ['null coordinate', feature('spot', {}, [null, 10])],
    ['string coordinate', feature('spot', {}, ['10', '10'])],
    ['tags not a list', feature('spot', { tags: 'a,b' })],
    ['tag not text', feature('spot', { tags: [1] })],
    ['too many tags', feature('spot', { tags: Array.from({ length: 31 }, () => 'a') })],
    ['tag too long', feature('spot', { tags: ['x'.repeat(51)] })],
    ['name too long', feature('place', { name: 'x'.repeat(201) })],
    ['notes too long', feature('spot', { notes: 'x'.repeat(10_001) })],
    ['no properties', { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] } }],
  ];
  for (const [label, f] of bad) {
    assert.throws(() => importFeatureCollection(db, bundle(feature('place', { name: 'fine' }), f), owner), ImportError, label);
  }
  assert.equal(count(db, 'places') + count(db, 'spots'), 0);
});

test('import: a failure mid-write rolls everything back', () => {
  const db = createDb(':memory:');
  const owner = crypto.randomUUID();
  // The place goes in, then reading this spot throws.
  const boom = feature('spot', { name: 'x' });
  Object.defineProperty(boom.properties, 'facingDeg', { get() { throw new Error('boom'); } });
  assert.throws(() => importFeatureCollection(db, bundle(feature('place', { name: 'fine' }), boom), owner), /boom/);
  assert.equal(count(db, 'places'), 0);
});

test('import: the feature cap', () => {
  const db = createDb(':memory:');
  const owner = crypto.randomUUID();
  const many = (n: number) => bundle(...Array.from({ length: n }, (_, i) => feature('spot', { name: `s${i}` })));
  assert.throws(() => importFeatureCollection(db, many(MAX_IMPORT_FEATURES + 1), owner), ImportError);
  assert.equal(count(db, 'spots'), 0);
  assert.deepEqual(importFeatureCollection(db, many(MAX_IMPORT_FEATURES), owner), { places: 0, spots: MAX_IMPORT_FEATURES });
});
