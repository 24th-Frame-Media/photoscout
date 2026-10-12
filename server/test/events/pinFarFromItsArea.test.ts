import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pinFarFromItsArea } from '../../src/events/events.js';

const hubs = [{ name: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 50 }];

test('a pin far from the area an event is filed under is not believed', () => {
  const kelsoScotland = { lat: 55.598, lng: -2.433 };
  const kelsoNsw = { lat: -33.418, lng: 149.614 };
  const lithgow = { lat: -33.48, lng: 150.15 };
  assert.equal(pinFarFromItsArea(kelsoScotland, 'Bathurst', hubs), true);
  assert.equal(pinFarFromItsArea(kelsoNsw, 'Bathurst', hubs), false);
  assert.equal(pinFarFromItsArea(lithgow, 'Bathurst', hubs), false, 'inside the slack around the radius');
  assert.equal(pinFarFromItsArea(kelsoScotland, '', hubs), false, 'filed under no area: the distance rule has it');
  assert.equal(pinFarFromItsArea({ lat: null, lng: null }, 'Bathurst', hubs), false);
});
