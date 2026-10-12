import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunLook } from '../src/map/sunLook.js';

test('sunLook: noon, sunset and night give different sky colours', () => {
  const noon = sunLook({ altitude: 60, azimuth: 180 });
  const sunset = sunLook({ altitude: 0, azimuth: 270 });
  const night = sunLook({ altitude: -30, azimuth: 90 });
  assert.notEqual(noon.sky['sky-color'], sunset.sky['sky-color']);
  assert.notEqual(sunset.sky['sky-color'], night.sky['sky-color']);
  assert.notEqual(noon.sky['sky-color'], night.sky['sky-color']);
});

test('sunLook: light polar = 90 - altitude, clamped', () => {
  assert.equal(sunLook({ altitude: 30, azimuth: 100 }).light.position[2], 60);
  assert.equal(sunLook({ altitude: -30, azimuth: 100 }).light.position[2], 90); // clamped
  assert.equal(sunLook({ altitude: 95, azimuth: 100 }).light.position[2], 0); // clamped
});

test('sunLook: hillshade illumination direction follows azimuth', () => {
  assert.equal(sunLook({ altitude: 20, azimuth: 123 }).hillshade['hillshade-illumination-direction'], 123);
});

test('overcast: clear and light cloud stay blue; heavy cloud, rain and fog go grey', async () => {
  const { overcast, sunLook } = await import('../src/map/sunLook.js');
  assert.equal(overcast(null), 0);
  assert.equal(overcast({ cloudPct: 15 }), 0);
  assert.ok(overcast({ cloudPct: 95 }) > 0.8);
  assert.ok(overcast({ cloudPct: 60, precipMm: 2 }) > overcast({ cloudPct: 60 }));
  assert.equal(overcast({ cloudPct: 0, fogLikely: true }), 1);
  const noon = { altitude: 60, azimuth: 0 };
  assert.notEqual(sunLook(noon, { cloudPct: 100 }).sky['sky-color'], sunLook(noon).sky['sky-color']);
});
