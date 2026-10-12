import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAurora } from '../src/feeds/spaceWeather.js';

test('parseAurora: extracts kpNow from observed and max Kp within next 24h from forecast', () => {
  const now = new Date('2026-09-30T12:00:00Z').getTime();

  const observed = [
    { time_tag: '2026-09-30T06:00:00', Kp: 2.33 },
    { time_tag: '2026-09-30T09:00:00', Kp: 3.67 },
    { time_tag: '2026-09-30T12:00:00', Kp: 4.0 },
  ];

  const forecast = [
    { time_tag: '2026-09-30T12:00:00', kp: 4.0 },
    { time_tag: '2026-09-30T15:00:00', kp: 5.33 },
    { time_tag: '2026-09-30T21:00:00', kp: 6.0 },
    { time_tag: '2026-10-01T06:00:00', kp: 4.67 }, // within 24h (ends 2026-10-01T12:00:00Z)
    { time_tag: '2026-10-01T18:00:00', kp: 8.0 }, // beyond 24h -> must NOT be picked as kpMaxNext24h
  ];

  const res = parseAurora(observed, forecast, now);
  assert.equal(res.kpNow, 4.0);
  assert.equal(res.kpMaxNext24h, 6.0);
});

test('parseAurora: handles tabular array-of-arrays format with header', () => {
  const now = new Date('2026-09-30T12:00:00Z').getTime();

  const observed = [
    ['time_tag', 'Kp', 'station_count'],
    ['2026-09-30T09:00:00', '3.33', '8'],
    ['2026-09-30T12:00:00', '5.0', '8'],
  ];

  const forecast = [
    ['time_tag', 'kp', 'observed'],
    ['2026-09-30T15:00:00', '5.67', 'predicted'],
  ];

  const res = parseAurora(observed, forecast, now);
  assert.equal(res.kpNow, 5.0);
  assert.equal(res.kpMaxNext24h, 5.67);
});

test('parseAurora: handles missing forecast, empty arrays, or malformed data gracefully', () => {
  assert.deepEqual(parseAurora(null, null), { kpNow: null, kpMaxNext24h: null });
  assert.deepEqual(parseAurora([], []), { kpNow: null, kpMaxNext24h: null });
  assert.deepEqual(parseAurora([{ time_tag: 'invalid', Kp: 'bad' }], null), { kpNow: null, kpMaxNext24h: null });

  // Only observed present
  const now = new Date('2026-09-30T12:00:00Z').getTime();
  const obsOnly = parseAurora([{ time_tag: '2026-09-30T12:00:00', Kp: 2.67 }], null, now);
  assert.equal(obsOnly.kpNow, 2.67);
  assert.equal(obsOnly.kpMaxNext24h, 2.67);
});
