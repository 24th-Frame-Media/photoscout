import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromLocalInput, gearTitle, instagramUrl, rideTitle, toLocalInput } from '../src/kit.js';

test('instagramUrl: only a plain handle becomes a link, and it is encoded', () => {
  assert.equal(instagramUrl('alice.cars_1'), 'https://instagram.com/alice.cars_1');
  for (const bad of ['', '@alice', 'a b', 'a/b', 'https://instagram.com/x', 'javascript:alert(1)', '..', 'x'.repeat(31), 'a?b=c', '<img>']) {
    assert.equal(instagramUrl(bad), null, bad);
  }
});

test('rideTitle and gearTitle leave out what is missing and do not repeat a brand', () => {
  assert.equal(rideTitle({ year: 2023, make: 'Porsche', model: '911 GT3', nickname: 'Gwen' }), '2023 Porsche 911 GT3 “Gwen”');
  assert.equal(rideTitle({ year: null, make: 'Mazda', model: 'MX-5', nickname: '' }), 'Mazda MX-5');
  assert.equal(gearTitle({ brand: 'Sigma', name: '150-600mm' }), 'Sigma 150-600mm');
  assert.equal(gearTitle({ brand: 'Canon', name: 'Canon EF 50mm' }), 'Canon EF 50mm');
});

test('datetime-local values round-trip through ISO in the reader\'s own zone', () => {
  const local = '2030-03-04T18:30';
  const iso = fromLocalInput(local);
  assert.ok(iso && iso.endsWith('Z'), 'the server is given an instant with its zone');
  assert.equal(toLocalInput(iso!), local);
  assert.equal(fromLocalInput(''), null);
  assert.equal(fromLocalInput('not a date'), null);
  assert.equal(toLocalInput('nope'), '');
});
