import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyLevel, kmh, motionOf, smoothBearing, zoomForSpeed, type Fix } from '../src/drive/camera.js';
import { formatDistance, formatRemaining, spokenDistance } from '../src/drive/format.js';
import { pickVoice } from '../src/drive/speech.js';
import { at } from './driveFixtures.js';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const fix = (east: number, north: number, t: number, extra: Partial<Fix> = {}): Fix => {
  const [lng, lat] = at(east, north);
  return { lng, lat, accuracy: 5, speed: null, heading: null, t, ...extra };
};

test('motionOf: trusts what the device reports', () => {
  const m = motionOf(null, fix(0, 0, 0, { speed: 20, heading: 135 }));
  assert.deepEqual(m, { speedMps: 20, heading: 135 });
});

test('motionOf: works speed and heading out from the move when the device gives neither', () => {
  const m = motionOf(fix(0, 0, 0), fix(0, 15, 1000));
  near(m.speedMps, 15, 0.1);
  near(m.heading!, 0, 0.5);
  const east = motionOf(fix(0, 0, 0), fix(14, 0, 1000));
  near(east.heading!, 90, 0.5);
});

test('motionOf: a standstill has no heading, and jitter inside the error is not movement', () => {
  assert.equal(motionOf(null, fix(0, 0, 0, { speed: 0, heading: 270 })).heading, null);
  assert.equal(motionOf(fix(0, 0, 0, { accuracy: 20 }), fix(4, 3, 1000, { accuracy: 20 })).speedMps, 0);
  const slow = motionOf(fix(0, 0, 0), fix(0, 1, 1000, { speed: 1 }));
  assert.equal(slow.heading, null, '1 m/s is a walk, not a heading');
  assert.equal(motionOf(null, fix(0, 0, 0)).speedMps, 0);
  assert.equal(motionOf(fix(0, 0, 0), fix(0, 0, 0)).speedMps, 0, 'two fixes at the same instant');
});

test('kmh and accuracyLevel', () => {
  assert.equal(kmh(13.9), 50);
  assert.equal(kmh(0), 0);
  assert.equal(accuracyLevel(5), 'good');
  assert.equal(accuracyLevel(15), 'good');
  assert.equal(accuracyLevel(30), 'fair');
  assert.equal(accuracyLevel(120), 'poor');
});

test('zoomForSpeed: closer when slow, wider when fast, smooth in between', () => {
  assert.equal(zoomForSpeed(0), 17.5);
  assert.equal(zoomForSpeed(-5), 17.5);
  assert.equal(zoomForSpeed(200), 14.7);
  let last = Infinity;
  for (let v = 0; v <= 130; v += 5) {
    const z = zoomForSpeed(v);
    assert.ok(z <= last, `${v} km/h`);
    last = z;
  }
  near(zoomForSpeed(50), 16.2);
  assert.ok(Math.abs(zoomForSpeed(51) - zoomForSpeed(50)) < 0.05);
});

test('smoothBearing: takes the short way round north', () => {
  near(smoothBearing(350, 10, 0.5), 0, 1e-9);
  near(smoothBearing(10, 350, 0.5), 0, 1e-9);
  near(smoothBearing(90, 180, 1), 180, 1e-9);
  near(smoothBearing(90, 180, 0), 90, 1e-9);
  near(smoothBearing(0, 90, 0.25), 22.5, 1e-9);
});

test('formatDistance and formatRemaining: what a driver reads', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(34), '30 m');
  assert.equal(formatDistance(180), '200 m');
  assert.equal(formatDistance(960), '950 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(14_400), '14 km');
  assert.equal(formatDistance(NaN), '');
  assert.equal(formatRemaining(10), '0 min');
  assert.equal(formatRemaining(12 * 60), '12 min');
  assert.equal(formatRemaining(65 * 60), '1 h 05 min');
});

test('spokenDistance: round numbers, said in full', () => {
  assert.equal(spokenDistance(487), '500 metres');
  assert.equal(spokenDistance(148), '150 metres');
  assert.equal(spokenDistance(20), '50 metres');
  assert.equal(spokenDistance(990), '1 kilometre');
  assert.equal(spokenDistance(1000), '1 kilometre');
  assert.equal(spokenDistance(1540), '1.5 kilometres');
});

test('pickVoice: Australian English first, then British, then any English', () => {
  const v = (lang: string) => ({ lang, name: lang });
  assert.equal(pickVoice([v('en-US'), v('en-AU'), v('en-GB')])?.lang, 'en-AU');
  assert.equal(pickVoice([v('en-US'), v('en_AU')])?.lang, 'en_AU', 'Android spells it with an underscore');
  assert.equal(pickVoice([v('en-US'), v('en-GB')])?.lang, 'en-GB');
  assert.equal(pickVoice([v('fr-FR'), v('en-IN')])?.lang, 'en-IN');
  assert.equal(pickVoice([v('fr-FR'), v('de-DE')]), undefined);
  assert.equal(pickVoice([]), undefined);
});
