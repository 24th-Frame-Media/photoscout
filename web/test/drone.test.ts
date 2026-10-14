import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  airspacesGeoJSON,
  airportsGeoJSON,
  droneFireHazardsGeoJSON,
  formatAirspaceDetail,
  formatAirportDetail,
  formatOpenAipAirportDetail,
  formatControlled3nmDetail,
  formatFireHazardDetail,
  flightRadiusGeoJSON,
  openAipAirportsGeoJSON,
  type DroneAirspaceItem,
  type DroneAirportItem,
  type DroneFireHazardItem,
} from '../src/map/drone.js';
import { categoryOf, CATEGORIES } from '../src/map/legend.js';
import { DRONE_LAYERS, CLICKABLE } from '../src/map/layers.js';

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

test('drone web: airportsGeoJSON never renders airport-point 3 NM buffers without runway thresholds', () => {
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
  assert.equal(controlled3nm.features.length, 0, 'A controlled airport without explicit threshold pairs must not receive an airport-point buffer');
  assert.equal(points.features[0].properties?.runwayGeometryUnavailable, true);

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

test('drone web: flightRadiusGeoJSON creates bounded circular polygon with default and custom radius in km', () => {
  const fc = flightRadiusGeoJSON(-33.42, 149.58, 5);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);

  const feature = fc.features[0];
  assert.equal(feature.geometry.type, 'Polygon');
  const poly = feature.geometry as GeoJSON.Polygon;
  assert.ok(poly.coordinates[0].length >= 32, 'Must have at least 32 points for circular polygon');
  // First and last coordinates must match for closed GeoJSON polygon
  const first = poly.coordinates[0][0];
  const last = poly.coordinates[0][poly.coordinates[0].length - 1];
  assert.equal(first[0], last[0]);
  assert.equal(first[1], last[1]);

  assert.equal(feature.properties?.radiusKm, 5);
  assert.equal(feature.properties?.radiusM, 5000);
  assertNoBannedWords(JSON.stringify(fc));
});

test('drone web: airportsGeoJSON generates runway markings for all valid runways and preserves overlaps', () => {
  const airportWithRunways: DroneAirportItem = {
    id: 'apt-ybth',
    name: 'Bathurst Aerodrome',
    icaoCode: 'YBTH',
    controlled: true,
    geometry: { type: 'Point', coordinates: [149.6525, -33.4097] },
    runways: [
      {
        id: 'rwy-17-35',
        designator: '17/35',
        thresholdEndpoints: [
          [149.651, -33.401],
          [149.655, -33.418],
        ],
      },
      {
        id: 'rwy-08-26',
        designator: '08/26',
        thresholdEndpoints: [
          [149.643, -33.410],
          [149.663, -33.410],
        ],
      },
    ],
  };

  const result = airportsGeoJSON([airportWithRunways]);

  // Points feature
  assert.equal(result.points.features.length, 1);
  assert.equal(result.points.features[0].properties?.runwayGeometryUnavailable, false);

  // Both runways produce 3NM buffers
  assert.equal(result.controlled3nm.features.length, 2, 'Must have 2 distinct 3 NM buffers');
  assert.equal(result.controlled3nm.features[0].properties?.kind, 'controlled-3nm-measurement-buffer');
  assert.equal(result.controlled3nm.features[0].properties?.authority, 'provider_context');

  // Both runways produce approach cores out to 7 km
  assert.equal(result.approachCore.features.length, 2, 'Must have 2 distinct approach cores');
  assert.equal(result.approachCore.features[0].properties?.kind, 'controlled-approach-core');
  assert.equal(result.approachCore.features[0].properties?.coreDistanceM, 7000);

  // Both runways produce 2 height bands each (7-8.5km) -> 4 height band features total
  assert.equal(result.approachHeightBand.features.length, 4, 'Must have 4 height band zones (2 per runway)');
  assert.equal(result.approachHeightBand.features[0].properties?.heightBand, '90m/300ft height-aware band');

  // Vector diagonal hatch lines generated
  assert.ok(result.heightBandHatch.features.length > 0, 'Must have vector diagonal hatch lines');
  assert.equal(result.heightBandHatch.features[0].geometry.type, 'LineString');

  assertNoBannedWords(JSON.stringify(result));
});

test('drone web: airportsGeoJSON handles missing runway geometry with unavailable state and no point buffer', () => {
  const airportNoRunways: DroneAirportItem = {
    id: 'apt-no-rwy',
    name: 'Controlled Field Without Runways',
    icaoCode: 'YXYZ',
    controlled: true,
    runwayGeometryUnavailable: true,
    geometry: { type: 'Point', coordinates: [149.65, -33.41] },
  };

  const result = airportsGeoJSON([airportNoRunways]);

  // Point feature has runwayGeometryUnavailable: true
  assert.equal(result.points.features.length, 1);
  assert.equal(result.points.features[0].properties?.runwayGeometryUnavailable, true);

  // MUST NOT render an airport-point 3NM circle as a legal substitute
  assert.equal(result.controlled3nm.features.length, 0, 'No 3NM buffer when runway geometry unavailable');
  assert.equal(result.approachCore.features.length, 0);
  assert.equal(result.approachHeightBand.features.length, 0);
  assert.equal(result.heightBandHatch.features.length, 0);

  // Detail popup renders required visible warning
  const html = formatAirportDetail(result.points.features[0].properties as any);
  assert.ok(
    html.includes('Runway geometry unavailable — verify current aerodrome data'),
    'Popup must visibly show Runway geometry unavailable'
  );
  assertNoBannedWords(html);
});

test('drone web: runway layers match legend category drone and are in DRONE_LAYERS', () => {
  const expectedLayers = [
    'drone-controlled-aerodrome-3nm-fill',
    'drone-controlled-aerodrome-3nm-line',
    'drone-runway-approach-core-fill',
    'drone-runway-approach-core-line',
    'drone-runway-approach-height-band-fill',
    'drone-runway-approach-height-band-line',
    'drone-runway-height-band-hatch-line',
  ];

  for (const layerId of expectedLayers) {
    assert.equal(
      categoryOf({ id: layerId, type: 'fill' } as any),
      'drone',
      `Layer ${layerId} must match legend category 'drone'`
    );
  }
});

test('drone web: openAipAirportsGeoJSON emits point features only and preserves basic runway context', () => {
  const airportsWithRunwayData: DroneAirportItem[] = [
    {
      id: 'apt-openaip-ybth',
      name: 'Bathurst Aerodrome Context',
      icaoCode: 'YBTH',
      controlled: true,
      geometry: { type: 'Point', coordinates: [149.6525, -33.4097] },
      distanceM: 2300,
      outsidePlannedRadius: false,
      runways: [
        {
          id: 'rwy-17-35',
          designator: '17/35',
          lengthM: 1705,
          thresholdEndpoints: [
            [149.651, -33.401],
            [149.655, -33.418],
          ],
        },
      ],
      controlledBuffer: {
        type: 'Polygon',
        coordinates: [
          [
            [149.60, -33.35],
            [149.70, -33.35],
            [149.70, -33.45],
            [149.60, -33.45],
            [149.60, -33.35],
          ],
        ],
      },
    },
    {
      id: 'apt-openaip-alais',
      name: 'Uncontrolled Bush Strip',
      controlled: false,
      geometry: { type: 'Point', coordinates: [149.80, -33.50] },
      distanceM: 8500,
      outsidePlannedRadius: true,
    },
  ];

  const fc = openAipAirportsGeoJSON(airportsWithRunwayData);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);

  // Every single feature emitted must be a Point feature
  for (const f of fc.features) {
    assert.equal(f.geometry.type, 'Point', 'OpenAIP airport context must emit point features only');
    assert.equal((f.geometry as GeoJSON.Point).coordinates.length, 2);
    assert.equal(typeof f.geometry.coordinates[0], 'number');
    assert.equal(typeof f.geometry.coordinates[1], 'number');
  }

  const f1 = fc.features[0];
  assert.equal(f1.id, 'apt-openaip-ybth');
  assert.equal(f1.properties?.controlled, true);
  assert.equal(f1.properties?.layerType, 'openaip-airport-context');
  assert.ok(f1.properties?.runwaySummary.includes('17/35'));
  assert.ok(f1.properties?.runwaySummary.includes('1705m'));
  assert.ok(f1.properties?.attribution.includes('CC BY-NC-SA'));
  assert.ok(f1.properties?.disclaimer.includes('Provider context only'));

  const f2 = fc.features[1];
  assert.equal(f2.properties?.controlled, false);
  assert.equal(f2.properties?.outsidePlannedRadius, true);

  assertNoBannedWords(JSON.stringify(fc));
});

test('drone web: openAipAirportsGeoJSON never infers threshold endpoints, 3 NM buffers, corridors, or height bands', () => {
  const airportsWithGeometryMetadata: DroneAirportItem[] = [
    {
      id: 'apt-yssy',
      name: 'Sydney Kingsford Smith',
      icaoCode: 'YSSY',
      controlled: true,
      geometry: { type: 'Point', coordinates: [151.177, -33.946] },
      runways: [
        {
          id: '16R-34L',
          designator: '16R/34L',
          lengthM: 3962,
          thresholdEndpoints: [
            [151.17, -33.93],
            [151.18, -33.96],
          ],
        },
      ],
      controlledBuffer: {
        type: 'Polygon',
        coordinates: [
          [
            [151.1, -33.9],
            [151.2, -33.9],
            [151.2, -34.0],
            [151.1, -34.0],
            [151.1, -33.9],
          ],
        ],
      },
    },
  ];

  const fc = openAipAirportsGeoJSON(airportsWithGeometryMetadata);

  // Must have exactly 1 Point feature and no non-point features
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].geometry.type, 'Point');

  // Verify it contains no polygon or corridor properties
  const rawJson = JSON.stringify(fc);
  assert.ok(!rawJson.includes('"Polygon"'), 'Must not emit any Polygon geometry');
  assert.ok(!rawJson.includes('"LineString"'), 'Must not emit any LineString geometry');
  assert.ok(!rawJson.includes('controlled-3nm-measurement-buffer'));
  assert.ok(!rawJson.includes('controlled-approach-core'));
  assert.ok(!rawJson.includes('heightBand'));

  assertNoBannedWords(rawJson);
});

test('drone web: formatOpenAipAirportDetail escapes provider strings, labels as OpenAIP airport context, attributes CC BY-NC-SA, and avoids banned clearance words', () => {
  const popupHtml = formatOpenAipAirportDetail({
    name: 'Bathurst <script>alert("xss")</script> Aerodrome',
    icaoCode: 'YBTH',
    controlled: true,
    outsidePlannedRadius: false,
    runwaySummary: '17/35 (1705m), 08/26 (1200m)',
  });

  // Escaping
  assert.ok(!popupHtml.includes('<script>'), 'Must escape HTML injection in name');
  assert.ok(popupHtml.includes('&lt;script&gt;'));

  // Visibly labelled as OpenAIP airport context
  assert.ok(popupHtml.includes('OpenAIP airport context'), 'Popup must visibly label OpenAIP airport context');

  // Attribution
  assert.ok(popupHtml.includes('openAIP (CC BY-NC-SA 4.0)'), 'Popup must include CC BY-NC-SA attribution');

  // Short warning that it is provider context only, may be incomplete, does not replace pilot checks
  assert.ok(
    popupHtml.includes('Provider context only, may be incomplete, and does not replace pilot checks'),
    'Popup must include provider context warning'
  );

  // Runway context
  assert.ok(popupHtml.includes('Runway context: 17/35 (1705m)'), 'Popup must show basic runway context');

  // Banned words check
  assertNoBannedWords(popupHtml);
});

test('drone web: DRONE_LAYERS and legend include drone-openaip-airports with distinct visual treatment and CLICKABLE integration', () => {
  assert.ok(
    DRONE_LAYERS.includes('drone-openaip-airports'),
    'DRONE_LAYERS must include drone-openaip-airports'
  );
  assert.ok(
    CLICKABLE.includes('drone-openaip-airports'),
    'CLICKABLE must include drone-openaip-airports for popup interaction'
  );
  assert.equal(
    categoryOf({ id: 'drone-openaip-airports', type: 'circle' } as any),
    'drone',
    'drone-openaip-airports must match legend category drone'
  );
});
