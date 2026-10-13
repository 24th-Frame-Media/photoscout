import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { setUserApiKey } from '../src/userApiKeys.js';
import {
  fetchOpenAipContext,
  normalizeAirspaceType,
  boundsFromPointRadius,
  type OpenAipResult,
} from '../src/providers/openaip.js';

const TEST_SECRET_KEY = 'secret-openaip-test-key-999888';

test('openaip: missing requester key returns typed not_configured result without network call', async () => {
  const db = createDb(':memory:');
  const userId = 'user-without-key';
  let networkCalls = 0;

  const mockFetch: typeof fetch = async () => {
    networkCalls++;
    throw new Error('Network should not be called');
  };

  const result = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(networkCalls, 0, 'no network call should be made when key is missing');
  assert.equal(result.status, 'not_configured');
  if (result.status === 'not_configured') {
    assert.ok(result.message.toLowerCase().includes('not configured'));
  }
});

test('openaip: valid request sends key ONLY in server-side header, not query string', async () => {
  const db = createDb(':memory:');
  const userId = 'user-with-key';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'pilot1', 'g-p1');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  const capturedRequests: Array<{ url: string; headers: HeadersInit | undefined }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    capturedRequests.push({ url, headers: init?.headers });

    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              _id: 'airspace-1',
              name: 'R559 BATHURST',
              type: 0, // RESTRICTED
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [149.5, -33.5],
                    [149.6, -33.5],
                    [149.6, -33.4],
                    [149.5, -33.4],
                    [149.5, -33.5],
                  ],
                ],
              },
              lowerLimit: { value: 0, unit: 0, referenceDatum: 0 },
              upperLimit: { value: 4500, unit: 0, referenceDatum: 1 },
            },
          ],
          totalCount: 1,
          totalPages: 1,
          page: 1,
          limit: 50,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/airports')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              _id: 'airport-1',
              name: 'Bathurst Airport',
              icaoCode: 'YBTH',
              geometry: { type: 'Point', coordinates: [149.65, -33.41] },
              runways: [{ designator: '17/35', surface: 0, lengthM: 1705 }],
            },
          ],
          totalCount: 1,
          totalPages: 1,
          page: 1,
          limit: 50,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  };

  const result = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 10000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'ok');
  assert.equal(capturedRequests.length, 2);

  for (const req of capturedRequests) {
    // Key must NOT be in the URL query string
    assert.ok(!req.url.includes(TEST_SECRET_KEY), 'API key leaked in URL query parameters');
    // Key MUST be in the x-openaip-api-key header
    const headers = req.headers as Record<string, string>;
    assert.equal(headers['x-openaip-api-key'], TEST_SECRET_KEY);
  }

  if (result.status === 'ok') {
    assert.equal(result.data.airspaces.length, 1);
    assert.equal(result.data.airspaces[0].name, 'R559 BATHURST');
    assert.equal(result.data.airspaces[0].typeName, 'RESTRICTED');
    assert.equal(result.data.airports.length, 1);
    assert.equal(result.data.airports[0].icaoCode, 'YBTH');
    assert.equal(result.source.provider, 'openaip');
    assert.equal(result.source.stale, false);
    assert.ok(result.source.attribution.includes('openAIP'));

    // Check payload serialization does not contain the key
    const jsonStr = JSON.stringify(result);
    assert.ok(!jsonStr.includes(TEST_SECRET_KEY), 'API key leaked in result payload');
  }
});

test('openaip: rejects invalid coordinates and overlarge areas', async () => {
  const db = createDb(':memory:');
  const userId = 'u-val';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'val', 'g-val');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  // Invalid latitude (out of bounds)
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        db,
        userId,
        lat: 95,
        lng: 149,
        radiusM: 5000,
      });
    },
    /latitude must be between -90 and 90/i
  );

  // Non-finite longitude
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        db,
        userId,
        lat: -33,
        lng: NaN,
        radiusM: 5000,
      });
    },
    /finite/i
  );

  // Overlarge radius (> 50,000 m)
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        db,
        userId,
        lat: -33,
        lng: 149,
        radiusM: 60000,
      });
    },
    /radius exceeds maximum/i
  );

  // Overlarge bbox span (> 1.0 degree)
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        db,
        userId,
        bbox: [140.0, -35.0, 142.5, -33.0],
      });
    },
    /bounding box extent exceeds maximum/i
  );
});

test('openaip: boundsFromPointRadius calculates correct bbox and clamps safely', () => {
  const bbox = boundsFromPointRadius(-33.42, 149.57, 10000);
  assert.equal(bbox.length, 4);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  assert.ok(minLng < 149.57 && maxLng > 149.57);
  assert.ok(minLat < -33.42 && maxLat > -33.42);
  assert.ok(maxLng - minLng < 1.0);
  assert.ok(maxLat - minLat < 1.0);
});

test('openaip: pagination is bounded and deduplicates records by source ID', async () => {
  const db = createDb(':memory:');
  const userId = 'u-page';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'page', 'g-page');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  let requestedPages = 0;

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/airspaces')) {
      requestedPages++;
      // Return 2 items, one of which is repeated across pages
      return new Response(
        JSON.stringify({
          items: [
            { _id: 'airspace-dup', name: 'Duplicated Airspace', type: 1, geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
            { _id: `airspace-p${requestedPages}`, name: `Airspace ${requestedPages}`, type: 2, geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
          ],
          totalCount: 100,
          totalPages: 10, // Claims 10 pages exist
          page: requestedPages,
          limit: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
  };

  const result = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    maxPages: 3, // Bounded at 3
  });

  assert.equal(result.status, 'ok');
  assert.ok(requestedPages <= 3, 'should not exceed maxPages limit');
  if (result.status === 'ok') {
    // Check that 'airspace-dup' is present only once
    const dupCount = result.data.airspaces.filter((a) => a.id === 'airspace-dup').length;
    assert.equal(dupCount, 1, 'items must be deduplicated by _id');
  }
});

test('openaip: stale cache is returned with explicit stale warning when upstream fails', async () => {
  const db = createDb(':memory:');
  const userId = 'u-stale';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'stale', 'g-stale');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  let upstreamShouldFail = false;

  const mockFetch: typeof fetch = async (input) => {
    if (upstreamShouldFail) {
      return new Response('OpenAIP Internal Server Error', { status: 500 });
    }
    const url = String(input);
    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [{ _id: 'a1', name: 'Airspace One', type: 0, geometry: { type: 'Point', coordinates: [149.5, -33.5] } }],
          totalPages: 1,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
  };

  let simulatedTime = 1_000_000;
  const now = () => simulatedTime;

  // 1. Initial successful fetch
  const res1 = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    now,
    cacheTtlMs: 60_000, // 1 min TTL
  });

  assert.equal(res1.status, 'ok');
  if (res1.status === 'ok') {
    assert.equal(res1.source.stale, false);
  }

  // 2. Advance time past TTL (cache expires) and trigger upstream failure
  simulatedTime += 120_000; // 2 min later
  upstreamShouldFail = true;

  const res2 = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    now,
    cacheTtlMs: 60_000,
  });

  // Stale cache must be returned with stale: true
  assert.equal(res2.status, 'stale');
  if (res2.status === 'stale') {
    assert.equal(res2.source.stale, true);
    assert.equal(res2.data.airspaces.length, 1);
    assert.equal(res2.data.airspaces[0].name, 'Airspace One');
  }
});

test('openaip: upstream errors without cache return typed error without leaking credentials', async () => {
  const db = createDb(':memory:');
  const userId = 'u-err';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'err', 'g-err');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  const mockFetch: typeof fetch = async () => {
    return new Response(`Error with key ${TEST_SECRET_KEY}`, { status: 502 });
  };

  const result = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.ok(!result.error.includes(TEST_SECRET_KEY), 'secret leaked in error message');
  }
});

test('openaip: malformed rows and items missing geometry are filtered safely', async () => {
  const db = createDb(':memory:');
  const userId = 'u-malformed';
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(userId, 'malformed', 'g-mal');
  setUserApiKey(db, userId, 'openaip', TEST_SECRET_KEY);

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [
            null, // null item
            {}, // empty object
            { _id: 'no-geom', name: 'Missing Geometry' },
            {
              _id: 'valid-airspace',
              name: 'Valid Airspace',
              type: 2,
              geometry: { type: 'Point', coordinates: [149.5, -33.5] },
            },
          ],
          totalPages: 1,
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        items: [
          { _id: 'no-airport-geom', name: 'Airport without geom' },
          { _id: 'valid-airport', name: 'Valid Airport', geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
        ],
        totalPages: 1,
      }),
      { status: 200 }
    );
  };

  const result = await fetchOpenAipContext({
    db,
    userId,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.equal(result.data.airspaces.length, 1);
    assert.equal(result.data.airspaces[0].id, 'valid-airspace');
    assert.equal(result.data.airports.length, 1);
    assert.equal(result.data.airports[0].id, 'valid-airport');
  }
});
