import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMoonIllumination, getMoonPosition } from 'suncalc';
import { galacticCorePosition, milkyWayWindows } from '../src/map/galaxy.js';
import { sunPos } from '../src/map/sun.js';

test('galacticCorePosition: max altitude over a day at Sydney (-33.87) is 90 - |L - dec| ~= 85.1°, transit due north', () => {
  const SYDNEY = { lat: -33.87, lng: 151.21 };
  const DEC = -29.008;
  const theoreticalMax = 90 - Math.abs(SYDNEY.lat - DEC); // ~85.138°

  const base = Date.parse('2026-06-21T00:00:00Z');
  let maxAlt = -90;
  let azAtMax = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const pos = galacticCorePosition(new Date(base + m * 60_000), SYDNEY.lat, SYDNEY.lng);
    if (pos.altitude > maxAlt) {
      maxAlt = pos.altitude;
      azAtMax = pos.azimuth;
    }
  }

  assert.ok(Math.abs(maxAlt - theoreticalMax) < 0.05, `expected max alt near ${theoreticalMax}, got ${maxAlt}`);
  // In southern hemisphere south of declination, transit is due North (0° / 360°)
  assert.ok(azAtMax < 1 || azAtMax > 359, `expected due north transit azimuth near 0/360, got ${azAtMax}`);
});

test('galacticCorePosition: northern latitude (London 51.5) transits due south at 90 - |L - dec| ~= 9.5°', () => {
  const LONDON = { lat: 51.5, lng: -0.12 };
  const DEC = -29.008;
  const theoreticalMax = 90 - Math.abs(LONDON.lat - DEC); // ~9.492°

  const base = Date.parse('2026-06-21T00:00:00Z');
  let maxAlt = -90;
  let azAtMax = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const pos = galacticCorePosition(new Date(base + m * 60_000), LONDON.lat, LONDON.lng);
    if (pos.altitude > maxAlt) {
      maxAlt = pos.altitude;
      azAtMax = pos.azimuth;
    }
  }

  assert.ok(Math.abs(maxAlt - theoreticalMax) < 0.05, `expected max alt near ${theoreticalMax}, got ${maxAlt}`);
  // In northern hemisphere north of declination, transit is due South (180°)
  assert.ok(Math.abs(azAtMax - 180) < 1, `expected due south transit azimuth near 180, got ${azAtMax}`);
});

test('galacticCorePosition: reaches zenith (90°) at latitude equal to declination', () => {
  const transitTime = Date.parse('2026-06-21T13:41:45.119Z');
  const pos = galacticCorePosition(new Date(transitTime), -29.008, 151.21);
  assert.ok(Math.abs(pos.altitude - 90) < 0.001, `expected 90° zenith altitude, got ${pos.altitude}`);
});

test('galacticCorePosition: hour angle symmetry around transit', () => {
  const transitTime = Date.parse('2026-06-21T13:41:45.119Z');
  const fourHours = 4 * 3600 * 1000;
  const before = galacticCorePosition(new Date(transitTime - fourHours), -33.87, 151.21);
  const after = galacticCorePosition(new Date(transitTime + fourHours), -33.87, 151.21);

  assert.ok(Math.abs(before.altitude - after.altitude) < 0.1, 'altitudes before and after transit should match');
  assert.ok(before.azimuth > 0 && before.azimuth < 180, 'rising in the eastern sky');
  assert.ok(after.azimuth > 180 && after.azimuth < 360, 'setting in the western sky');
});

test('milkyWayWindows: dark winter night in Sydney finds windows with all criteria met', () => {
  const SYDNEY = { lat: -33.87, lng: 151.21 };
  const day = new Date('2026-06-14T12:00:00Z');
  const windows = milkyWayWindows(day, SYDNEY.lat, SYDNEY.lng);

  assert.ok(windows.length > 0, 'expected Milky Way windows in winter new moon in Sydney');
  for (const w of windows) {
    assert.ok(w.start instanceof Date);
    assert.ok(w.end instanceof Date);
    assert.ok(w.start.getTime() < w.end.getTime(), 'start before end');

    for (let t = w.start.getTime(); t < w.end.getTime(); t += 10 * 60_000) {
      const dt = new Date(t);
      const sun = sunPos(dt, SYDNEY.lat, SYDNEY.lng);
      assert.ok(sun.altitude < -18, `sun alt must be < -18, was ${sun.altitude}`);

      const core = galacticCorePosition(dt, SYDNEY.lat, SYDNEY.lng);
      assert.ok(core.altitude > 15, `core alt must be > 15, was ${core.altitude}`);

      const moon = getMoonPosition(dt, SYDNEY.lat, SYDNEY.lng);
      const moonIll = getMoonIllumination(dt);
      const moonOk = moon.altitude <= 0 || moonIll.fraction < 0.2;
      assert.ok(moonOk, `moon must be below horizon or < 0.2 lit, was alt ${moon.altitude} frac ${moonIll.fraction}`);
    }
  }
});

test('milkyWayWindows: full moon suppresses windows when bright moon is above horizon', () => {
  const SYDNEY = { lat: -33.87, lng: 151.21 };
  const day = new Date('2026-06-29T12:00:00Z');
  const windows = milkyWayWindows(day, SYDNEY.lat, SYDNEY.lng);

  for (const w of windows) {
    for (let t = w.start.getTime(); t < w.end.getTime(); t += 10 * 60_000) {
      const dt = new Date(t);
      const moon = getMoonPosition(dt, SYDNEY.lat, SYDNEY.lng);
      assert.ok(moon.altitude <= 0, `on full moon night, window must have moon below horizon (was ${moon.altitude})`);
    }
  }
});

test('milkyWayWindows: degrades gracefully on invalid input', () => {
  assert.deepEqual(milkyWayWindows(new Date('2026-06-14T00:00:00Z'), NaN, 151.21), []);
  assert.deepEqual(milkyWayWindows(new Date('2026-06-14T00:00:00Z'), -33.87, Infinity), []);
});
