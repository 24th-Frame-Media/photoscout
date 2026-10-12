import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseMarine,
  tideExtremes,
  compassDir,
  fetchMarine,
  marineCache,
} from '../src/feeds/marine.js';

test('parseMarine: returns coastal: false for empty or invalid data', () => {
  assert.deepEqual(parseMarine(null), { coastal: false, hourly: [] });
  assert.deepEqual(parseMarine({}), { coastal: false, hourly: [] });
  assert.deepEqual(parseMarine({ hourly: {} }), { coastal: false, hourly: [] });
});

test('parseMarine: returns coastal: false when all marine values are null (inland)', () => {
  const inlandJson = {
    hourly: {
      time: ['2026-09-30T00:00', '2026-09-30T01:00'],
      sea_level_height_msl: [null, null],
      wave_height: [null, null],
      wave_direction: [null, null],
      wave_period: [null, null],
      swell_wave_height: [null, null],
      swell_wave_direction: [null, null],
    },
  };
  assert.deepEqual(parseMarine(inlandJson), { coastal: false, hourly: [] });
});

test('parseMarine: parses coastal hourly series with UTC timestamps', () => {
  const coastalJson = {
    hourly: {
      time: ['2026-09-30T00:00', 1790733600],
      sea_level_height_msl: [0.65, 0.42],
      wave_height: [1.2, 1.1],
      wave_direction: [135, 140],
      wave_period: [9.5, 9.8],
      swell_wave_height: [0.8, 0.7],
      swell_wave_direction: [120, 125],
    },
  };
  const res = parseMarine(coastalJson);
  assert.equal(res.coastal, true);
  assert.equal(res.hourly.length, 2);
  assert.deepEqual(res.hourly[0], {
    time: '2026-09-30T00:00:00.000Z',
    seaLevelHeightMsl: 0.65,
    waveHeight: 1.2,
    waveDirection: 135,
    wavePeriod: 9.5,
    swellWaveHeight: 0.8,
    swellWaveDirection: 120,
  });
  assert.deepEqual(res.hourly[1], {
    time: new Date(1790733600 * 1000).toISOString(),
    seaLevelHeightMsl: 0.42,
    waveHeight: 1.1,
    waveDirection: 140,
    wavePeriod: 9.8,
    swellWaveHeight: 0.7,
    swellWaveDirection: 125,
  });
});

test('compassDir: maps degrees to 16-point compass directions', () => {
  assert.equal(compassDir(0), 'N');
  assert.equal(compassDir(360), 'N');
  assert.equal(compassDir(45), 'NE');
  assert.equal(compassDir(90), 'E');
  assert.equal(compassDir(135), 'SE');
  assert.equal(compassDir(180), 'S');
  assert.equal(compassDir(225), 'SW');
  assert.equal(compassDir(270), 'W');
  assert.equal(compassDir(315), 'NW');
  assert.equal(compassDir(11), 'N');
  assert.equal(compassDir(12), 'NNE');
});

test('tideExtremes: returns empty array if series is too short or has no extrema', () => {
  assert.deepEqual(tideExtremes([]), []);
  assert.deepEqual(
    tideExtremes([
      { time: '2026-09-30T00:00:00Z', seaLevelHeightMsl: 0.5 },
      { time: '2026-09-30T01:00:00Z', seaLevelHeightMsl: 0.6 },
    ]),
    [],
  );
  // Monotonic increase
  assert.deepEqual(
    tideExtremes([
      { time: '2026-09-30T00:00:00Z', seaLevelHeightMsl: 0.1 },
      { time: '2026-09-30T01:00:00Z', seaLevelHeightMsl: 0.5 },
      { time: '2026-09-30T02:00:00Z', seaLevelHeightMsl: 0.8 },
    ]),
    [],
  );
});

test('tideExtremes: calculates high tide with parabolic interpolation', () => {
  // y(x) = -(x - 0.2)^2 + 1.04 = -x^2 + 0.4x + 1
  // x = -1 (00:00Z) -> y = -0.4
  // x = 0  (01:00Z) -> y = 1.0
  // x = 1  (02:00Z) -> y = 0.4
  // Peak should be at x = +0.2 (+12 min -> 01:12:00Z), height = 1.04 m
  const series = [
    { time: '2026-09-30T00:00:00.000Z', seaLevelHeightMsl: -0.4 },
    { time: '2026-09-30T01:00:00.000Z', seaLevelHeightMsl: 1.0 },
    { time: '2026-09-30T02:00:00.000Z', seaLevelHeightMsl: 0.4 },
  ];
  const extremes = tideExtremes(series);
  assert.equal(extremes.length, 1);
  assert.deepEqual(extremes[0], {
    type: 'high',
    time: '2026-09-30T01:12:00.000Z',
    height: 1.04,
  });
});

test('tideExtremes: calculates low tide with parabolic interpolation', () => {
  // y(x) = (x + 0.3)^2 + 0.20 = x^2 + 0.6x + 0.29
  // x = -1 (03:00Z) -> y = 0.69
  // x = 0  (04:00Z) -> y = 0.29
  // x = 1  (05:00Z) -> y = 1.89
  // Peak at x = -0.3 (-18 min -> 03:42:00Z), height = 0.20 m
  const series = [
    { time: '2026-09-30T03:00:00.000Z', seaLevelHeightMsl: 0.69 },
    { time: '2026-09-30T04:00:00.000Z', seaLevelHeightMsl: 0.29 },
    { time: '2026-09-30T05:00:00.000Z', seaLevelHeightMsl: 1.89 },
  ];
  const extremes = tideExtremes(series);
  assert.equal(extremes.length, 1);
  assert.deepEqual(extremes[0], {
    type: 'low',
    time: '2026-09-30T03:42:00.000Z',
    height: 0.2,
  });
});

test('tideExtremes: handles multiple alternating tides and skips nulls', () => {
  const series = [
    { time: '2026-09-30T00:00:00.000Z', seaLevelHeightMsl: 0.2 },
    { time: '2026-09-30T01:00:00.000Z', seaLevelHeightMsl: 0.8 },
    { time: '2026-09-30T02:00:00.000Z', seaLevelHeightMsl: 0.3 },
    { time: '2026-09-30T03:00:00.000Z', seaLevelHeightMsl: null },
    { time: '2026-09-30T04:00:00.000Z', seaLevelHeightMsl: 0.5 },
    { time: '2026-09-30T05:00:00.000Z', seaLevelHeightMsl: 0.1 },
    { time: '2026-09-30T06:00:00.000Z', seaLevelHeightMsl: 0.6 },
  ];
  const extremes = tideExtremes(series);
  assert.equal(extremes.length, 2);
  assert.equal(extremes[0].type, 'high');
  assert.equal(extremes[1].type, 'low');
});

test('fetchMarine: fetches, caches per 0.05° cell, handles stale-on-error and inland', async () => {
  marineCache.clear();
  let requests = 0;

  const server = http.createServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    const lat = Number(url.searchParams.get('latitude'));

    if (lat === -33.85) {
      // Coastal point
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hourly: {
          time: ['2026-09-30T00:00', '2026-09-30T01:00', '2026-09-30T02:00'],
          sea_level_height_msl: [0.3, 1.2, 0.4],
          wave_height: [1.5, 1.4, 1.3],
          wave_direction: [135, 135, 135],
          wave_period: [10, 10, 10],
          swell_wave_height: [1.2, 1.1, 1.0],
          swell_wave_direction: [130, 130, 130],
        },
      }));
    } else if (lat === -33.45) {
      // Inland point
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hourly: {
          time: ['2026-09-30T00:00', '2026-09-30T01:00'],
          sea_level_height_msl: [null, null],
          wave_height: [null, null],
          wave_direction: [null, null],
          wave_period: [null, null],
          swell_wave_height: [null, null],
          swell_wave_direction: [null, null],
        },
      }));
    } else {
      res.writeHead(500);
      res.end('Upstream error');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Fetch coastal point (-33.86, 151.21 snaps to -33.85, 151.20)
    const coastal = await fetchMarine(baseUrl, -33.86, 151.21);
    assert.equal(coastal.coastal, true);
    assert.equal(coastal.hourly?.length, 3);
    assert.equal(coastal.tides?.length, 1);
    assert.equal(coastal.tides?.[0].type, 'high');
    assert.equal(requests, 1);

    // 2. Fetch slightly different point that snaps to same cell (-33.84, 151.22 snaps to -33.85, 151.20)
    const cached = await fetchMarine(baseUrl, -33.84, 151.22);
    assert.deepEqual(cached, coastal);
    assert.equal(requests, 1); // No new request; cache hit

    // 3. Inland point returns coastal: false
    const inland = await fetchMarine(baseUrl, -33.45, 149.58);
    assert.equal(inland.coastal, false);
    assert.equal(requests, 2);

    // 4. Stale-on-error: if server fails on a known cell, cached data is returned
    // Overwrite server handler to always fail
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      requests++;
      res.writeHead(500);
      res.end('Internal Server Error');
    });

    const staleResult = await fetchMarine(baseUrl, -33.85, 151.20);
    assert.deepEqual(staleResult, coastal);

    // 5. Unknown cell on error returns { coastal: false } gracefully without throwing
    const errorResult = await fetchMarine(baseUrl, 10.0, 20.0);
    assert.equal(errorResult.coastal, false);
  } finally {
    server.close();
  }
});
