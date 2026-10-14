import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './httpHarness.js';
import type { AerodromeDatasetManifest } from '../src/drone/aerodromes.js';

const BANNED_WORDS = ['\\blegal\\b', '\\bsafe\\b', '\\bapproved\\b', '\\bcleared\\b', '\\bauthorised\\b'];

function assertNoBannedWords(text: string) {
  for (const pattern of BANNED_WORDS) {
    const re = new RegExp(pattern, 'i');
    assert.ok(!re.test(text), `Response contained banned word matching ${pattern}: "${text.slice(0, 300)}"`);
  }
}

// Synthetic test manifest with explicit provenance
const SYNTHETIC_DATASET: AerodromeDatasetManifest = {
  schemaVersion: '1.0.0',
  datasetId: 'synthetic-test-aerodromes',
  name: 'Synthetic Test Aerodrome Registry',
  publishedAt: '2026-10-01T00:00:00Z',
  effectiveDate: '2026-10-01',
  licence: 'Test-Only Non-Production Licence',
  authority: 'synthetic_test',
  records: [
    {
      id: 'TEST-YRED',
      name: 'Synthetic Redcliffe Test Aerodrome',
      icaoCode: 'YRED',
      controlled: true,
      geometry: {
        type: 'Point',
        coordinates: [153.068, -27.218],
      },
      runways: [
        {
          id: 'RWY-07-25',
          designator: '07/25',
          thresholdEndpoints: [
            [153.063, -27.219],
            [153.073, -27.217],
          ],
        },
      ],
      provenance: {
        source: 'Synthetic Test Dataset for Local Overlay',
        licence: 'Test-Only Non-Production Licence',
        authority: 'synthetic_test',
        effectiveDate: '2026-10-01',
        sourceDate: '2026-09-30',
        verifiedThresholds: true,
      },
    },
    {
      id: 'TEST-NO-RUNWAY',
      name: 'Synthetic Controlled Without Thresholds',
      icaoCode: 'YCNT',
      controlled: true,
      geometry: {
        type: 'Point',
        coordinates: [153.05, -27.20],
      },
      runways: [],
      provenance: {
        source: 'Synthetic Test Dataset for Local Overlay',
        licence: 'Test-Only Non-Production Licence',
        authority: 'synthetic_test',
        effectiveDate: '2026-10-01',
      },
    },
    {
      id: 'TEST-UNCONTROLLED',
      name: 'Synthetic Uncontrolled Field',
      icaoCode: 'YUNC',
      controlled: false,
      geometry: {
        type: 'Point',
        coordinates: [153.15, -27.25],
      },
      provenance: {
        source: 'Synthetic Test Dataset for Local Overlay',
        licence: 'Test-Only Non-Production Licence',
        authority: 'synthetic_test',
        effectiveDate: '2026-10-01',
      },
    },
    {
      id: 'TEST-FARAWAY',
      name: 'Synthetic Faraway Aerodrome',
      icaoCode: 'YFAR',
      controlled: true,
      geometry: {
        type: 'Point',
        coordinates: [151.0, -33.0],
      },
      runways: [
        {
          id: 'RWY-12-30',
          designator: '12/30',
          thresholdEndpoints: [
            [150.99, -33.01],
            [151.01, -32.99],
          ],
        },
      ],
      provenance: {
        source: 'Synthetic Test Dataset for Local Overlay',
        licence: 'Test-Only Non-Production Licence',
        authority: 'synthetic_test',
        effectiveDate: '2026-10-01',
      },
    },
  ],
};

test('aerodromes http: public access without sign-in or session', async () => {
  const harness = await startApp();
  try {
    const anon = harness.client();
    const res = await anon('GET', '/api/aerodromes/context?lat=-27.218&lng=153.068&radiusM=5000');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.available, 'boolean');
    assertNoBannedWords(JSON.stringify(res.json));
  } finally {
    await harness.close();
  }
});

test('aerodromes http: validates query bounds and parameters', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();

    // Missing lat/lng
    const r1 = await client('GET', '/api/aerodromes/context');
    assert.equal(r1.status, 400);

    // Invalid latitude
    const r2 = await client('GET', '/api/aerodromes/context?lat=95&lng=150');
    assert.equal(r2.status, 400);

    // Invalid longitude
    const r3 = await client('GET', '/api/aerodromes/context?lat=-27&lng=250');
    assert.equal(r3.status, 400);

    // Negative radius
    const r4 = await client('GET', '/api/aerodromes/context?lat=-27&lng=150&radiusM=-10');
    assert.equal(r4.status, 400);

    // Excessive radius
    const r5 = await client('GET', '/api/aerodromes/context?lat=-27&lng=150&radiusM=100000');
    assert.equal(r5.status, 400);
  } finally {
    await harness.close();
  }
});

test('aerodromes http: empty/unavailable state when dataset is not installed', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    const res = await client('GET', '/api/aerodromes/context?lat=-27.218&lng=153.068&radiusM=5000');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, false);
    assert.equal(res.json.status, 'unavailable');
    assert.deepEqual(res.json.aerodromes, []);
    assert.equal(res.json.closestAirport, null);
    assert.ok(res.json.message.includes('not installed') || res.json.message.includes('unavailable'));
  } finally {
    await harness.close();
  }
});

test('aerodromes http: never calls OpenAIP or any external upstream service', async () => {
  const harness = await startApp();
  let upstreamCalled = false;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('openaip') || url.includes('api.core.openaip.net')) {
        upstreamCalled = true;
      }
      return originalFetch(input, init);
    };

    const client = harness.client();
    const res = await client('GET', '/api/aerodromes/context?lat=-27.218&lng=153.068&radiusM=5000');
    assert.equal(res.status, 200);
    assert.equal(upstreamCalled, false, 'No OpenAIP fetch should occur for local aerodrome endpoint');
  } finally {
    globalThis.fetch = originalFetch;
    await harness.close();
  }
});

test('aerodromes http: loads synthetic dataset and returns valid runway geometry without point buffer fallback', async () => {
  const harness = await startApp();
  try {
    // Write synthetic dataset to harness DATA_DIR
    const dataDir = process.env.DATA_DIR!;
    fs.writeFileSync(path.join(dataDir, 'aerodromes.json'), JSON.stringify(SYNTHETIC_DATASET));

    const client = harness.client();
    const res = await client('GET', '/api/aerodromes/context?lat=-27.218&lng=153.068&radiusM=5000');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.source?.datasetId, 'synthetic-test-aerodromes');
    assert.equal(res.json.source?.authority, 'synthetic_test');

    const aerodromes = res.json.aerodromes;
    assert.ok(aerodromes.length >= 1);

    // Controlled airport with runway thresholds has runwayMarkings and controlledBuffer
    const yred = aerodromes.find((a: any) => a.id === 'TEST-YRED');
    assert.ok(yred, 'TEST-YRED should be returned');
    assert.equal(yred.controlled, true);
    assert.ok(yred.runwayMarkings, 'Runway markings must be generated');
    assert.ok(yred.controlledBuffer, '3 NM controlled buffer must be generated from thresholds');
    assert.equal(yred.runwayGeometryUnavailable, false);
    assert.equal(yred.provenance.source, 'Synthetic Test Dataset for Local Overlay');

    // Controlled airport without runway geometry: NO point buffer fallback
    const noRunway = aerodromes.find((a: any) => a.id === 'TEST-NO-RUNWAY');
    if (noRunway) {
      assert.equal(noRunway.runwayGeometryUnavailable, true);
      assert.equal(noRunway.controlledBuffer, undefined);
    }

    assertNoBannedWords(JSON.stringify(res.json));
  } finally {
    await harness.close();
  }
});

test('aerodromes http: closest-local-aerodrome outside planned radius when none in radius', async () => {
  const harness = await startApp();
  try {
    const dataDir = process.env.DATA_DIR!;
    fs.writeFileSync(path.join(dataDir, 'aerodromes.json'), JSON.stringify(SYNTHETIC_DATASET));

    const client = harness.client();
    // Query somewhere far from Brisbane (e.g. Melbourne -37.8, 144.9)
    const res = await client('GET', '/api/aerodromes/context?lat=-37.8&lng=144.9&radiusM=1000');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    // When none in radius, closest outside is returned
    assert.equal(res.json.aerodromes.length, 1);
    assert.equal(res.json.aerodromes[0].outsidePlannedRadius, true);
    assert.ok(res.json.closestAirport);
    assert.equal(res.json.closestAirport.outsidePlannedRadius, true);
    assert.equal(res.json.closestAirport.id, 'TEST-FARAWAY');
  } finally {
    await harness.close();
  }
});

test('aerodromes http: approach corridor reaching into planned radius includes aerodrome even if marker is outside', async () => {
  const harness = await startApp();
  try {
    const dataDir = process.env.DATA_DIR!;
    // Airport at -27.218, 153.068 with runway 07/25.
    // Query a point 6 km west along runway centerline where approach corridor reaches
    fs.writeFileSync(path.join(dataDir, 'aerodromes.json'), JSON.stringify(SYNTHETIC_DATASET));

    const client = harness.client();
    // 153.00, -27.22 is ~6.7 km west of YRED. With radius 500m, YRED point is outside,
    // but the 7-8.5km approach corridor reaches here!
    const res = await client('GET', '/api/aerodromes/context?lat=-27.22&lng=153.00&radiusM=1000');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    const yred = res.json.aerodromes.find((a: any) => a.id === 'TEST-YRED');
    assert.ok(yred, 'YRED should be included because its approach corridor intersects the circle');
    assert.equal(yred.outsidePlannedRadius, false);
  } finally {
    await harness.close();
  }
});

test('aerodromes http: provenance validation rejects invalid records', async () => {
  const harness = await startApp();
  try {
    const dataDir = process.env.DATA_DIR!;
    const invalidDataset = {
      schemaVersion: '1.0.0',
      datasetId: 'invalid-test',
      name: 'Invalid Test Dataset',
      publishedAt: '2026-10-01T00:00:00Z',
      effectiveDate: '2026-10-01',
      licence: 'Test',
      authority: 'synthetic_test',
      records: [
        // Missing provenance
        {
          id: 'BAD-1',
          name: 'Missing Provenance',
          controlled: false,
          geometry: { type: 'Point', coordinates: [153.0, -27.0] },
        },
        // Missing authority in provenance
        {
          id: 'BAD-2',
          name: 'Missing Authority',
          controlled: false,
          geometry: { type: 'Point', coordinates: [153.0, -27.0] },
          provenance: { source: 'A', licence: 'B', effectiveDate: '2026-01-01' },
        },
        // Invalid coordinates
        {
          id: 'BAD-3',
          name: 'Invalid Coords',
          controlled: false,
          geometry: { type: 'Point', coordinates: [999.0, -27.0] },
          provenance: { source: 'A', licence: 'B', authority: 'C', effectiveDate: '2026-01-01' },
        },
        // Valid record
        {
          id: 'GOOD-1',
          name: 'Good Record',
          controlled: false,
          geometry: { type: 'Point', coordinates: [153.0, -27.0] },
          provenance: { source: 'Valid Source', licence: 'CC BY', authority: 'Authoritative', effectiveDate: '2026-01-01' },
        },
      ],
    };

    fs.writeFileSync(path.join(dataDir, 'aerodromes.json'), JSON.stringify(invalidDataset));

    const client = harness.client();
    const res = await client('GET', '/api/aerodromes/context?lat=-27.0&lng=153.0&radiusM=5000');
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    assert.equal(res.json.source?.recordCount, 1);
    assert.equal(res.json.aerodromes.length, 1);
    assert.equal(res.json.aerodromes[0].id, 'GOOD-1');
  } finally {
    await harness.close();
  }
});

