import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEARING_MINI_MAP_SHIFT_STEP_DEG,
  BEARING_MINI_MAP_STEP_DEG,
  buildBestHitGeoJSON,
  buildSectorPolygon,
  buildSunRaysGeoJSON,
  buildWedgesGeoJSON,
  computeRayLengthKm,
  DEFAULT_LINE_LENGTH_KM,
  nudgeBearing,
  pointCoordToBearing,
} from '../src/components/BearingMiniMap.js';

test('nudgeBearing: ArrowRight nudges by 1 degree', () => {
  assert.equal(nudgeBearing(0, 'ArrowRight', false), 1);
  assert.equal(nudgeBearing(45.5, 'ArrowRight', false), 46.5);
});

test('nudgeBearing: ArrowLeft nudges by 1 degree', () => {
  assert.equal(nudgeBearing(10, 'ArrowLeft', false), 9);
  assert.equal(nudgeBearing(180.3, 'ArrowLeft', false), 179.3);
});

test('nudgeBearing: ArrowRight with Shift nudges by 10 degrees', () => {
  assert.equal(nudgeBearing(50, 'ArrowRight', true), 60);
  assert.equal(nudgeBearing(340, 'ArrowRight', true), 350);
});

test('nudgeBearing: ArrowLeft with Shift nudges by 10 degrees', () => {
  assert.equal(nudgeBearing(50, 'ArrowLeft', true), 40);
  assert.equal(nudgeBearing(9, 'ArrowLeft', true), 359);
});

test('nudgeBearing: wraps 359 + 1 -> 0', () => {
  assert.equal(nudgeBearing(359, 'ArrowRight', false), 0);
});

test('nudgeBearing: wraps 0 - 1 -> 359', () => {
  assert.equal(nudgeBearing(0, 'ArrowLeft', false), 359);
});

test('nudgeBearing: wraps across 0 boundary with Shift step 10', () => {
  assert.equal(nudgeBearing(355, 'ArrowRight', true), 5);
  assert.equal(nudgeBearing(5, 'ArrowLeft', true), 355);
});

test('nudgeBearing: null bearing defaults to 0 and nudges correctly', () => {
  assert.equal(nudgeBearing(null, 'ArrowRight', false), 1);
  assert.equal(nudgeBearing(null, 'ArrowLeft', false), 359);
  assert.equal(nudgeBearing(null, 'ArrowRight', true), 10);
  assert.equal(nudgeBearing(null, 'ArrowLeft', true), 350);
});

test('nudgeBearing: non-arrow key returns null', () => {
  assert.equal(nudgeBearing(100, 'ArrowUp', false), null);
  assert.equal(nudgeBearing(100, 'ArrowDown', false), null);
  assert.equal(nudgeBearing(100, 'Enter', false), null);
  assert.equal(nudgeBearing(100, 'KeyA', false), null);
});

test('pointCoordToBearing: compass bearings for cardinal directions', () => {
  const origin = { lat: 0, lng: 0 };

  // Due North: lat increases, lng unchanged -> ~0 deg
  const northBearing = pointCoordToBearing(origin, { lat: 1, lng: 0 });
  assert.ok(Math.abs(northBearing - 0) < 0.1 || Math.abs(northBearing - 360) < 0.1, `expected ~0, got ${northBearing}`);

  // Due East: lat unchanged, lng increases -> ~90 deg
  const eastBearing = pointCoordToBearing(origin, { lat: 0, lng: 1 });
  assert.ok(Math.abs(eastBearing - 90) < 0.1, `expected ~90, got ${eastBearing}`);

  // Due South: lat decreases, lng unchanged -> ~180 deg
  const southBearing = pointCoordToBearing(origin, { lat: -1, lng: 0 });
  assert.ok(Math.abs(southBearing - 180) < 0.1, `expected ~180, got ${southBearing}`);

  // Due West: lat unchanged, lng decreases -> ~270 deg
  const westBearing = pointCoordToBearing(origin, { lat: 0, lng: -1 });
  assert.ok(Math.abs(westBearing - 270) < 0.1, `expected ~270, got ${westBearing}`);
});

test('computeRayLengthKm: fallback when bounds are absent or invalid', () => {
  assert.equal(computeRayLengthKm({ lat: -33, lng: 150 }, null), DEFAULT_LINE_LENGTH_KM);
  assert.equal(computeRayLengthKm({ lat: -33, lng: 150 }, undefined), DEFAULT_LINE_LENGTH_KM);
});

test('computeRayLengthKm: calculates distance to farthest visible corner with margin', () => {
  const spot = { lat: 0, lng: 0 };
  const bounds = {
    getWest: () => -0.01,
    getEast: () => 0.01,
    getSouth: () => -0.01,
    getNorth: () => 0.01,
  };
  const lengthKm = computeRayLengthKm(spot, bounds, 1.2);
  // corner (-0.01, -0.01) is ~1.57 km away
  assert.ok(lengthKm > 1.5, `expected length > 1.5 km, got ${lengthKm}`);
});

test('buildSunRaysGeoJSON: produces sunrise and sunset line features with custom length', () => {
  const date = new Date('2026-06-21T12:00:00Z');
  const customLengthKm = 2.5;
  const fc = buildSunRaysGeoJSON(-33.419, 149.577, customLengthKm, date);

  assert.equal(fc.type, 'FeatureCollection');
  assert.ok(fc.features.length >= 1);

  const kinds = fc.features.map((f) => f.properties?.kind);
  assert.ok(kinds.includes('sunrise') || kinds.includes('sunset'));

  for (const feature of fc.features) {
    assert.equal(feature.type, 'Feature');
    assert.equal(feature.geometry.type, 'LineString');
    const coords = (feature.geometry as GeoJSON.LineString).coordinates;
    assert.equal(coords.length, 2);
    assert.equal(coords[0][0], 149.577);
    assert.equal(coords[0][1], -33.419);
  }
});

test('buildSectorPolygon: produces closed polygon coordinates ring', () => {
  const ring = buildSectorPolygon(-33.419, 149.577, 60, 120, 1.5, 4);
  // steps = 4 means 1 centre origin + (4 + 1) perimeter points + 1 closing point = 7 points
  assert.equal(ring.length, 7);
  // starts and ends at origin [lng, lat]
  assert.deepEqual(ring[0], [149.577, -33.419]);
  assert.deepEqual(ring[ring.length - 1], [149.577, -33.419]);
  // perimeter points are distinct from origin
  assert.notDeepEqual(ring[1], ring[0]);
});

test('buildWedgesGeoJSON: creates polygon and label features for solar extremes', () => {
  const range = {
    sunrise: {
      minDeg: 62.5,
      maxDeg: 118.2,
      minDate: new Date('2026-06-21T07:05:00Z'),
      maxDate: new Date('2026-12-21T05:48:00Z'),
    },
    sunset: {
      minDeg: 241.8,
      maxDeg: 297.5,
      minDate: new Date('2026-06-21T17:01:00Z'),
      maxDate: new Date('2026-12-21T20:10:00Z'),
    },
  };
  const { wedges, labels } = buildWedgesGeoJSON(-33.419, 149.577, range, 2.0);

  assert.equal(wedges.type, 'FeatureCollection');
  assert.equal(wedges.features.length, 2);
  assert.equal(wedges.features[0].properties?.kind, 'sunrise');
  assert.equal(wedges.features[1].properties?.kind, 'sunset');
  assert.equal(wedges.features[0].geometry.type, 'Polygon');

  assert.equal(labels.type, 'FeatureCollection');
  assert.equal(labels.features.length, 4);
  for (const labelFeature of labels.features) {
    assert.equal(labelFeature.geometry.type, 'Point');
    assert.ok(typeof labelFeature.properties?.label === 'string');
    assert.ok(labelFeature.properties?.label.length > 0);
  }
});

test('buildBestHitGeoJSON: returns empty feature collection when no best hit', () => {
  const fc = buildBestHitGeoJSON(-33.419, 149.577, undefined, 2.0);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 0);
});

test('buildBestHitGeoJSON: returns point feature along bearing with date label', () => {
  const hit = { time: new Date('2026-04-15T06:30:00Z'), azimuthDeg: 80.5 };
  const fc = buildBestHitGeoJSON(-33.419, 149.577, hit, 2.0);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].geometry.type, 'Point');
  assert.ok(typeof fc.features[0].properties?.label === 'string');
  assert.ok(fc.features[0].properties?.label.length > 0);
});

