import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseCameras,
  fetchCameras,
  clearCameraCache,
  setCameraCacheForTest,
} from '../src/feeds/cameras.js';

test('parseCameras: parses valid TfNSW cameras FeatureCollection fixture', () => {
  const fixture = {
    type: 'FeatureCollection',
    rights: {
      copyright: 'Transport for NSW',
      licence: 'https://opendata.transport.nsw.gov.au/dataset/live-traffic-cameras',
    },
    features: [
      {
        type: 'Feature',
        id: 'cam-001',
        geometry: {
          type: 'Point',
          coordinates: [151.10533, -34.02977],
        },
        properties: {
          region: 'SYD_SOUTH',
          title: '5 Ways (Miranda)',
          view: '5 Ways at The Boulevarde looking west towards Sutherland.',
          direction: 'W',
          href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
        },
      },
      {
        type: 'Feature',
        id: 'cam-002',
        geometry: {
          type: 'Point',
          coordinates: [151.161891, -33.933667],
        },
        properties: {
          region: 'SYD_MET',
          title: 'Airport Drive (Mascot)',
          view: 'Airport Drive at Marsh Street looking east towards the city.',
          direction: 'E',
          href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/airport_dr_mascot.jpeg',
        },
      },
    ],
  };

  const parsed = parseCameras(fixture);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    id: 'cam-001',
    title: '5 Ways (Miranda)',
    view: '5 Ways at The Boulevarde looking west towards Sutherland.',
    direction: 'W',
    region: 'SYD_SOUTH',
    imageUrl: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
    point: [151.10533, -34.02977],
  });
  assert.deepEqual(parsed[1], {
    id: 'cam-002',
    title: 'Airport Drive (Mascot)',
    view: 'Airport Drive at Marsh Street looking east towards the city.',
    direction: 'E',
    region: 'SYD_MET',
    imageUrl: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/airport_dr_mascot.jpeg',
    point: [151.161891, -33.933667],
  });
});

test('parseCameras: handles fallback fields and defensive parsing', () => {
  const fixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        // id in properties instead of feature.id, imageUrl instead of href
        geometry: {
          type: 'Point',
          coordinates: ['150.5', '-33.5'],
        },
        properties: {
          id: 'prop-id-123',
          title: 'Great Western Hwy (Katoomba)',
          view: 'Looking west',
          direction: 'W',
          region: 'REG_WEST',
          imageUrl: 'https://www.livetraffic.com/images/katoomba.jpg',
        },
      },
      // Missing geometry -> skip
      {
        type: 'Feature',
        id: 'no-geom',
        properties: { title: 'No geometry' },
      },
      // Non-point geometry -> skip
      {
        type: 'Feature',
        id: 'line-geom',
        geometry: { type: 'LineString', coordinates: [[150, -33], [151, -34]] },
        properties: { title: 'Line' },
      },
      // Invalid coords -> skip
      {
        type: 'Feature',
        id: 'bad-coords',
        geometry: { type: 'Point', coordinates: [999, 999] },
        properties: { title: 'Bad coords' },
      },
      // Malformed feature object -> skip
      null,
      'not-an-object',
    ],
  };

  const parsed = parseCameras(fixture);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    id: 'prop-id-123',
    title: 'Great Western Hwy (Katoomba)',
    view: 'Looking west',
    direction: 'W',
    region: 'REG_WEST',
    imageUrl: 'https://www.livetraffic.com/images/katoomba.jpg',
    point: [150.5, -33.5],
  });
});

test('parseCameras: returns empty array on invalid or empty input', () => {
  assert.deepEqual(parseCameras(null), []);
  assert.deepEqual(parseCameras(undefined), []);
  assert.deepEqual(parseCameras({}), []);
  assert.deepEqual(parseCameras({ features: 'not an array' }), []);
  assert.deepEqual(parseCameras('string'), []);
});

test('fetchCameras: fetches, caches for 10 min, reports 401/403, and serves stale-on-error', async () => {
  clearCameraCache();

  let requestCount = 0;
  let receivedAuthHeader = '';
  let serverStatus = 200;

  const sampleGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'test-cam',
        geometry: { type: 'Point', coordinates: [151.2, -33.8] },
        properties: {
          title: 'Sydney Harbour Bridge',
          view: 'Looking south',
          direction: 'S',
          region: 'SYD_CBD',
          href: 'https://webcams.transport.nsw.gov.au/bridge.jpeg',
        },
      },
    ],
  };

  const server = http.createServer((req, res) => {
    requestCount++;
    receivedAuthHeader = req.headers.authorization || '';

    if (serverStatus === 401 || serverStatus === 403) {
      res.writeHead(serverStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ErrorDetails: { Code: 'Unauthorized' } }));
      return;
    }

    if (serverStatus !== 200) {
      res.writeHead(serverStatus);
      res.end('Server error');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sampleGeoJson));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const testUrl = `http://127.0.0.1:${port}/v1/live/cameras`;

  try {
    // 1. Initial successful fetch
    const cameras = await fetchCameras('secret-key-123', testUrl);
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0].id, 'test-cam');
    assert.equal(receivedAuthHeader, 'apikey secret-key-123');
    assert.equal(requestCount, 1);

    // 2. Second fetch with same key -> served from in-memory cache (no network call)
    const cached = await fetchCameras('secret-key-123', testUrl);
    assert.deepEqual(cached, cameras);
    assert.equal(requestCount, 1);

    // 3. Stale-on-error: when upstream returns 500 and cache is expired, stale cached data is served
    serverStatus = 500;
    // Set cache timestamp to 15 minutes ago (expired beyond 10 min TTL)
    setCameraCacheForTest('secret-key-123', cameras, Date.now() - 15 * 60_000);
    const staleResult = await fetchCameras('secret-key-123', testUrl);
    assert.deepEqual(staleResult, cameras);
    assert.equal(requestCount, 2); // Attempted network fetch, but fell back to stale on error

    // Without any cache, 500 throws
    clearCameraCache();
    await assert.rejects(
      async () => fetchCameras('secret-key-123', testUrl),
      /TfNSW cameras returned 500/,
    );

    // 4. 401/403 authorization error -> clear descriptive message
    serverStatus = 401;
    clearCameraCache();
    await assert.rejects(
      async () => fetchCameras('invalid-key', testUrl),
      /not authorised: add the Live Traffic product to your TfNSW key/,
    );

    serverStatus = 403;
    clearCameraCache();
    await assert.rejects(
      async () => fetchCameras('invalid-key', testUrl),
      /not authorised: add the Live Traffic product to your TfNSW key/,
    );
  } finally {
    server.close();
    clearCameraCache();
  }
});
