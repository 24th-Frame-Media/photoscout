import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRestStop, type RestStopCandidate } from '../src/sources/restStops.js';

const route: [number, number][] = [[149, -33], [149.2, -33]];
const candidate = (patch: Partial<RestStopCandidate>): RestStopCandidate => ({
  lat: -33,
  lng: 149.1,
  name: '',
  kind: 'rest area',
  hasToilets: false,
  ...patch,
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
