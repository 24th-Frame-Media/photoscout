import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  airspacesGeoJSON,
  airportsGeoJSON,
  droneFireHazardsGeoJSON,
  formatAirspaceDetail,
  formatAirportDetail,
  formatControlled3nmDetail,
  formatFireHazardDetail,
  type DroneAirspaceItem,
  type DroneAirportItem,
  type DroneFireHazardItem,
} from '../src/map/drone.js';
import { categoryOf, CATEGORIES } from '../src/map/legend.js';
import { DRONE_LAYERS } from '../src/map/layers.js';

const BANNED_WORDS = ['\\blegal\\b', '\\bsafe\\b', '\\bapproved\\b', '\\bcleared\\b', '\\bauthorised\\b'];

function assertNoBannedWords(text: string) {
  for (const pattern of BANNED_WORDS) {
    const re = new RegExp(pattern, 'i');
    assert.ok(!re.test(text), `Text contained banned word matching ${pattern}: "${text.slice(0, 300)}"`);
  }
}

test('drone web: airspacesGeoJSON converts OpenAIP airspaces and preserves [lng, lat] coordinates', () => {
  const airspaces: DroneAirspaceItem[] = [
    {
      id: 'as-prohibited',
      name: 'R401A Prohibited Area',
      type: 3,
      typeName: 'PROHIBITED',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150.1, -33.5],
            [150.2, -33.5],
            [150.2, -33.6],
            [150.1, -33.6],
            [150.1, -33.5],
          ],
        ],
      },
    },
    {
      id: 'as-restricted',
      name: 'R402 Restricted Area',
      type: 1,
      typeName: 'RESTRICTED',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150.3, -33.5],
            [150.4, -33.5],
            [150.4, -33.6],
            [150.3, -33.6],
            [150.3, -33.5],
          ],
        ],
      },
    },
    {
      id: 'as-ctr',
      name: 'Bathurst CTR',
      type: 4,
      typeName: 'CTR',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [149.5, -33.4],
            [149.7, -33.4],
            [149.7, -33.6],
            [149.5, -33.6],
            [149.5, -33.4],
          ],
        ],
      },
    },
  ];

  const fc = airspacesGeoJSON(airspaces);
  assert.equal(fc.features.length, 3);

  const [f1, f2, f3] = fc.features;
  assert.equal(f1.properties?.kind, 'prohibited');
  assert.equal(f2.properties?.kind, 'restricted');
  assert.equal(f3.properties?.kind, 'controlled');

  // Verify coordinates ordering [lng, lat]
  const geom = f1.geometry as GeoJSON.Polygon;
  const [lng, lat] = geom.coordinates[0][0];
  assert.equal(lng, 150.1);
  assert.equal(lat, -33.5);

  assertNoBannedWords(JSON.stringify(fc));
});

test('drone web: airportsGeoJSON emits 3 NM buffers ONLY where controlled === true', () => {
  const airports: DroneAirportItem[] = [
    {
      id: 'apt-controlled',
      name: 'Sydney Kingsford Smith',
      icaoCode: 'YSSY',
      controlled: true,
      geometry: { type: 'Point', coordinates: [151.17, -33.94] },
      controlledBuffer: {
        type: 'Polygon',
        coordinates: [
          [
            [151.10, -33.90],
            [151.24, -33.90],
            [151.24, -33.98],
            [151.10, -33.98],
            [151.10, -33.90],
          ],
        ],
      },
    },
    {
      id: 'apt-uncontrolled',
      name: 'Camden Airfield',
      icaoCode: 'YSCN',
      controlled: false,
      geometry: { type: 'Point', coordinates: [150.68, -34.04] },
    },
    {
      id: 'apt-unknown',
      name: 'Unknown Helipad',
      geometry: { type: 'Point', coordinates: [150.80, -33.80] },
    },
  ];

  const { points, controlled3nm } = airportsGeoJSON(airports);
  assert.equal(points.features.length, 3);
  assert.equal(controlled3nm.features.length, 1, 'Only positively controlled airport receives 3 NM buffer');

  const bufFeature = controlled3nm.features[0];
  assert.equal(bufFeature.properties?.airportId, 'apt-controlled');
  assert.equal(bufFeature.properties?.rule, 'CASR 101.238(d)(v)');
  assert.equal(bufFeature.properties?.sourceClassificationVerified, true);

  assertNoBannedWords(JSON.stringify(points));
  assertNoBannedWords(JSON.stringify(controlled3nm));
});

test('drone web: droneFireHazardsGeoJSON formats modelled 2 km hazard polygons with disclaimer', () => {
  const hazards: DroneFireHazardItem[] = [
    {
      id: 'fire-101',
      title: 'Lithgow Bush Fire',
      category: 'Watch and Act',
      status: 'Out of Control',
      updated: '2026-10-13T10:00:00Z',
      sourceGeometry: { type: 'Point', coordinates: [150.15, -33.48] },
      bufferGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150.13, -33.46],
            [150.17, -33.46],
            [150.17, -33.50],
            [150.13, -33.50],
            [150.13, -33.46],
          ],
        ],
      },
      bufferMetres: 2000,
      bufferPolicyId: 'photoscout-fire-hazard-2km-v1',
      disclaimer: 'Modelled fire-operation hazard buffer — do not launch; emergency approval may be required.',
    },
  ];

  const fc = droneFireHazardsGeoJSON(hazards);
  assert.equal(fc.features.length, 1);
  const f = fc.features[0];
  assert.equal(f.properties?.id, 'fire-101');
  assert.equal(f.properties?.bufferMetres, 2000);
  assert.ok(f.properties?.disclaimer.includes('Modelled'));
  assert.ok(!f.properties?.disclaimer.toLowerCase().includes('official restriction'));

  assertNoBannedWords(JSON.stringify(fc));
});

test('drone web: legend toggle groups all drone layers into drone category', () => {
  const droneCategory = CATEGORIES.find((c) => c.key === 'drone');
  assert.ok(droneCategory, 'drone category must exist in legend CATEGORIES');
  assert.equal(droneCategory.label, 'Drone planning');
  assert.equal(droneCategory.group, 'Overlays');
  assert.equal(droneCategory.defaultOn, false);

  for (const layerId of DRONE_LAYERS) {
    const layer = { id: layerId, type: 'line' };
    assert.equal(categoryOf(layer), 'drone', `Layer ${layerId} must match drone category`);
  }

  // Non-drone layers must not match drone
  assert.notEqual(categoryOf({ id: 'fires-pts', type: 'circle', source: 'fires' }), 'drone');
  assert.notEqual(categoryOf({ id: 'planes', type: 'symbol' }), 'drone');
  assert.notEqual(categoryOf({ id: 'trains', type: 'circle' }), 'drone');
});

test('drone web: detail popups escape provider strings and never contain banned words or secrets', () => {
  const airspaceDetail = formatAirspaceDetail({
    name: '<script>alert("xss")</script> R401 Airspace',
    typeName: 'PROHIBITED',
    lowerLimitText: 'GND',
    upperLimitText: 'FL180',
  });
  assert.ok(!airspaceDetail.includes('<script>'), 'Must escape HTML in airspace name');
  assert.ok(airspaceDetail.includes('&lt;script&gt;'));
  assertNoBannedWords(airspaceDetail);

  const airportDetail = formatAirportDetail({
    name: 'Sydney <b>Airport</b>',
    icaoCode: 'YSSY',
    controlled: true,
  });
  assert.ok(!airportDetail.includes('<b>Airport</b>'));
  assert.ok(airportDetail.includes('&lt;b&gt;'));
  assertNoBannedWords(airportDetail);

  const fireDetail = formatFireHazardDetail({
    title: 'Bush Fire <img src=x>',
    category: 'Emergency Warning',
    status: 'Out of Control',
    bufferMetres: 2000,
    disclaimer: 'Modelled fire-operation hazard buffer — do not launch; emergency approval may be required.',
  });
  assert.ok(!fireDetail.includes('<img'));
  assert.ok(fireDetail.toLowerCase().includes('modelled'));
  assertNoBannedWords(fireDetail);

  const controlled3nmDetail = formatControlled3nmDetail({
    airportName: 'Bathurst Aerodrome',
    icaoCode: 'YBTH',
    disclaimer: 'Controlled aerodrome 3 NM conditional planning buffer (CASR 101.238(d)(v)).',
  });
  assert.ok(controlled3nmDetail.includes('Bathurst Aerodrome'));
  assert.ok(controlled3nmDetail.includes('YBTH'));
  assert.ok(controlled3nmDetail.includes('3 NM Buffer'));
  assert.ok(controlled3nmDetail.includes('250 g'));
  assertNoBannedWords(controlled3nmDetail);
});
