import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnScore, hourAt, pickRadarFrame, weatherIcon } from '../src/map/weather.js';

const idx = { host: 'https://h', radar: { past: [{ time: 1000, path: '/a' }, { time: 1600, path: '/b' }], nowcast: [{ time: 2200, path: '/n' }] } };

test('pickRadarFrame: latest frame at or before t, else null out of range', () => {
  assert.equal(pickRadarFrame(idx, 1700_000)?.path, '/b');
  assert.equal(pickRadarFrame(idx, 2300_000)?.nowcast, true);
  assert.equal(pickRadarFrame(idx, 900_000)?.path, '/a');
  assert.equal(pickRadarFrame(idx, 3000_000), null);
  assert.equal(pickRadarFrame(idx, 0), null);
});

test('hourAt / weatherIcon', () => {
  const h = { time: '2026-09-27T03:00:00.000Z', tempC: 1, cloudPct: 0, cloudLowPct: 0, cloudMidPct: 0, cloudHighPct: 0, precipMm: 0, precipProbPct: 0, windKmh: 0, gustKmh: 0, visibilityM: 500, weatherCode: 0, fogLikely: true, aod: null };
  const f = { lat: 0, lng: 0, fetchedAt: '', hourly: [h] };
  assert.equal(hourAt(f, Date.parse('2026-09-27T03:40:00Z')), h);
  assert.equal(hourAt(f, Date.parse('2026-09-28T03:40:00Z')), null);
  assert.equal(weatherIcon(h), '🌫');
  assert.equal(weatherIcon({ ...h, fogLikely: false, weatherCode: 63 }), '🌧');
});

test('burnScore: clear sky is dull', () => {
  const res = burnScore({ cloudHighPct: 0, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.1 }, 0);
  assert.equal(res.score, 0);
  assert.equal(res.label, 'Dull');
});

test('burnScore: ideal 50% high cloud + clear low is fiery/vibrant', () => {
  const fiery = burnScore({ cloudHighPct: 50, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.1 }, 0);
  assert.equal(fiery.score, 100);
  assert.equal(fiery.label, 'Fiery');

  const vibrant = burnScore({ cloudHighPct: 20, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.1 }, 0);
  assert.ok(vibrant.score >= 51 && vibrant.score <= 75);
  assert.equal(vibrant.label, 'Vibrant');
});

test('burnScore: overcast is dull', () => {
  const res = burnScore({ cloudHighPct: 100, cloudMidPct: 100, cloudLowPct: 100, visibilityM: 15_000, aod: 0.1 }, 100);
  assert.ok(res.score <= 20);
  assert.equal(res.label, 'Dull');
});

test('burnScore: low cloud on horizon kills it', () => {
  const ideal = burnScore({ cloudHighPct: 50, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.1 }, 0);
  assert.equal(ideal.label, 'Fiery');

  const killed = burnScore({ cloudHighPct: 50, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.1 }, 60);
  assert.ok(killed.score <= 20);
  assert.equal(killed.label, 'Dull');
});

test('burnScore: nulls handled gracefully', () => {
  const allNull = burnScore({ cloudHighPct: null, cloudMidPct: null, cloudLowPct: null, visibilityM: null, aod: null }, null);
  assert.equal(allNull.score, 0);
  assert.equal(allNull.label, 'Dull');

  const idealWithNulls = burnScore({ cloudHighPct: 50, cloudMidPct: null, cloudLowPct: null, visibilityM: null, aod: null }, null);
  assert.equal(idealWithNulls.score, 100);
  assert.equal(idealWithNulls.label, 'Fiery');
});

test('burnScore: clarity penalties for low visibility or high aod', () => {
  const lowVis = burnScore({ cloudHighPct: 50, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 4000, aod: 0.1 }, 0);
  assert.equal(lowVis.score, 40);
  assert.equal(lowVis.label, 'Fair');

  const highAod = burnScore({ cloudHighPct: 50, cloudMidPct: 0, cloudLowPct: 0, visibilityM: 20_000, aod: 0.7 }, 0);
  assert.equal(highAod.score, 50);
  assert.equal(highAod.label, 'Fair');
});
