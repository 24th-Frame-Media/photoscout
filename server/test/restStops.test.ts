import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRestStop, restSearchAnchors, type RestStopCandidate } from '../src/sources/restStops.js';
import { haversine } from '../src/geo.js';

const route: [number, number][] = [[149, -33], [149.2, -33]];
const candidate = (patch: Partial<RestStopCandidate>): RestStopCandidate => ({
  lat: -33,
  lng: 149.1,
  name: '',
  kind: 'rest area',
  hasToilets: false,
  ...patch,
});

test('equivalent nearby facilities beat a distant stop further along the route', () => {
  const picked = chooseRestStop([[149, -33], [151, -33]], [149, -33], [
    candidate({ name: 'Distant', lng: 150.9, kind: 'service station', hasToilets: true }),
    candidate({ name: 'Nearby', lng: 149.01, kind: 'service station', hasToilets: true }),
  ]);
  assert.equal(picked?.name, 'Nearby');
});

test('rest searches cover sparse route interiors starting at the leader with a bounded lookahead', () => {
  const anchors = restSearchAnchors([[149, -33], [153, -33]], [150, -33]);
  assert.ok(haversine(-33, 150, anchors[0][1], anchors[0][0]) < 10);
  assert.ok(anchors.length <= 50);
  for (let i = 1; i < anchors.length; i++) assert.ok(haversine(anchors[i - 1][1], anchors[i - 1][0], anchors[i][1], anchors[i][0]) <= 5_010);
  assert.ok(haversine(-33, 150, anchors.at(-1)![1], anchors.at(-1)![0]) <= 100_010);
});

test('chooseRestStop stays near the remaining route and prefers Macca\'s or services over a generic stop', () => {
  const picked = chooseRestStop(route, [149, -33], [
    candidate({ name: 'Far services', kind: 'service station', hasToilets: true, lng: 149.3 }),
    candidate({ name: 'Picnic bay', kind: 'rest area', lng: 149.101 }),
    candidate({ name: 'McDonald\'s Bathurst', kind: 'McDonald\'s', lng: 149.105 }),
  ]);
  assert.deepEqual(picked, candidate({ name: 'McDonald\'s Bathurst', kind: 'McDonald\'s', lng: 149.105 }));
});

test('chooseRestStop gives an explicitly toilet-tagged service station priority at the same small detour', () => {
  const picked = chooseRestStop(route, [149, -33], [
    candidate({ name: 'Fuel only', kind: 'service station', lng: 149.105 }),
    candidate({ name: 'Caltex', kind: 'service station', hasToilets: true, lng: 149.106 }),
  ]);
  assert.equal(picked?.name, 'Caltex');
});

test('chooseRestStop ignores places behind the leader and excessive detours', () => {
  const picked = chooseRestStop(route, [149.1, -33], [
    candidate({ name: 'Behind', kind: 'McDonald\'s', lng: 149.01 }),
    candidate({ name: 'Too far away', kind: 'service station', lng: 150, lat: -34 }),
  ]);
  assert.equal(picked, null);
});
