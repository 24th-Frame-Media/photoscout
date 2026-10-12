import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  mergeAircraft,
  deadReckon,
  isValidHex,
  isValidCallsign,
  parseAircraft,
  parseFlightroute,
  ExpiryCache,
  fetchPlaneInfo,
  aircraftCache,
  routeCache,
} from '../src/feeds/planes.js';

test('deadReckon: null when track or speed is missing', () => {
  assert.equal(deadReckon({ lat: -33.4, lon: 149.6, track: null, gs: 200 }, 10), null);
  assert.equal(deadReckon({ lat: -33.4, lon: 149.6, track: 90, gs: null }, 10), null);
});

test('deadReckon: due east at a known speed moves roughly the right distance', () => {
  const start = { lat: -33.419, lon: 149.577, track: 90, gs: 300 }; // knots
  const at10 = deadReckon(start, 10)!;
  // 300kt * 1.852 km/h/kt * (10/60)h ≈ 92.6 km east, negligible latitude drift near this latitude.
  const expectedKm = 300 * 1.852 * (10 / 60);
  const lngKmPerDeg = 111.32 * Math.cos((start.lat * Math.PI) / 180);
  const movedKm = (at10.lon - start.lon) * lngKmPerDeg;
  assert.ok(Math.abs(movedKm - expectedKm) < 1, `expected ~${expectedKm}km east, got ${movedKm}km`);
  assert.ok(Math.abs(at10.lat - start.lat) < 0.01, 'latitude barely moves heading due east');
});

test('isValidHex: exactly 6 hex characters', () => {
  assert.equal(isValidHex('7C6B37'), true);
  assert.equal(isValidHex('7c6b37'), true);
  assert.equal(isValidHex('000000'), true);
  assert.equal(isValidHex('abcdef'), true);

  assert.equal(isValidHex('7C6B3'), false); // 5 chars
  assert.equal(isValidHex('7C6B378'), false); // 7 chars
  assert.equal(isValidHex('GGGGGG'), false); // non-hex
  assert.equal(isValidHex(' 7C6B3'), false); // whitespace
  assert.equal(isValidHex(''), false);
  assert.equal(isValidHex(null), false);
  assert.equal(isValidHex(undefined), false);
  assert.equal(isValidHex(123456), false);
});

test('isValidCallsign: alphanumeric up to 8 characters', () => {
  assert.equal(isValidCallsign('QFA7'), true);
  assert.equal(isValidCallsign('qfa7'), true);
  assert.equal(isValidCallsign('AAL100'), true);
  assert.equal(isValidCallsign('A'), true);
  assert.equal(isValidCallsign('12345678'), true);

  assert.equal(isValidCallsign(''), false);
  assert.equal(isValidCallsign('TOOLONG123'), false); // 10 chars
  assert.equal(isValidCallsign('QF-7'), false); // hyphen
  assert.equal(isValidCallsign('QF 7'), false); // space
  assert.equal(isValidCallsign(null), false);
  assert.equal(isValidCallsign(undefined), false);
});

test('parseAircraft: parses valid adsbdb aircraft response', () => {
  const fixture = {
    response: {
      aircraft: {
        type: 'A320 232',
        icao_type: 'A320',
        manufacturer: 'Airbus',
        mode_s: '7C6B37',
        registration: 'VH-VGP',
        registered_owner: 'Jetstar Airways',
      },
    },
  };
  const parsed = parseAircraft(fixture);
  assert.deepEqual(parsed, {
    type: 'A320 232',
    manufacturer: 'Airbus',
    registration: 'VH-VGP',
    owner: 'Jetstar Airways',
  });
});

test('parseAircraft: falls back to icao_type if type is missing', () => {
  const fixture = {
    response: {
      aircraft: {
        icao_type: 'B738',
        manufacturer: 'Boeing',
        registration: 'VH-VUI',
        registered_owner: 'Virgin Australia',
      },
    },
  };
  const parsed = parseAircraft(fixture);
  assert.deepEqual(parsed, {
    type: 'B738',
    manufacturer: 'Boeing',
    registration: 'VH-VUI',
    owner: 'Virgin Australia',
  });
});

test('parseAircraft: returns null for unknown aircraft or malformed input', () => {
  assert.equal(parseAircraft({ response: 'unknown aircraft' }), null);
  assert.equal(parseAircraft({ response: {} }), null);
  assert.equal(parseAircraft({}), null);
  assert.equal(parseAircraft(null), null);
  assert.equal(parseAircraft('not json'), null);
});

test('parseFlightroute: parses valid adsbdb flightroute response', () => {
  const fixture = {
    response: {
      flightroute: {
        callsign: 'QFA7',
        airline: { name: 'Qantas' },
        origin: { iata_code: 'SYD', municipality: 'Sydney' },
        destination: { iata_code: 'DFW', municipality: 'Dallas-Fort Worth' },
      },
    },
  };
  const parsed = parseFlightroute(fixture);
  assert.deepEqual(parsed, {
    airline: 'Qantas',
    origin: 'SYD',
    destination: 'DFW',
  });
});

test('parseFlightroute: falls back to municipality when iata_code is missing', () => {
  const fixture = {
    response: {
      flightroute: {
        callsign: 'LOCAL1',
        airline: null,
        origin: { iata_code: null, municipality: 'Bathurst' },
        destination: { iata_code: '', municipality: 'Dubbo' },
      },
    },
  };
  const parsed = parseFlightroute(fixture);
  assert.deepEqual(parsed, {
    airline: null,
    origin: 'Bathurst',
    destination: 'Dubbo',
  });
});

test('parseFlightroute: returns null for unknown callsign or malformed input', () => {
  assert.equal(parseFlightroute({ response: 'unknown callsign' }), null);
  assert.equal(parseFlightroute({ response: {} }), null);
  assert.equal(parseFlightroute({}), null);
  assert.equal(parseFlightroute(null), null);
});

test('ExpiryCache: set, get, negative cache, expiry, and capacity eviction', () => {
  const cache = new ExpiryCache<string | null>(50, 3); // 50ms TTL, max 3 entries

  // Set and get
  cache.set('a', 'valA');
  assert.deepEqual(cache.get('a'), { hit: true, val: 'valA' });
  assert.deepEqual(cache.get('missing'), { hit: false, val: undefined });

  // Negative cache
  cache.set('b', null);
  assert.deepEqual(cache.get('b'), { hit: true, val: null });

  // Capacity cap: adding 'c' and 'd' (cache max 3 entries)
  cache.set('c', 'valC');
  assert.equal(cache.size, 3);
  cache.set('d', 'valD'); // Should evict oldest ('a')
  assert.equal(cache.size, 3);
  assert.deepEqual(cache.get('a'), { hit: false, val: undefined });
  assert.deepEqual(cache.get('b'), { hit: true, val: null });
  assert.deepEqual(cache.get('c'), { hit: true, val: 'valC' });
  assert.deepEqual(cache.get('d'), { hit: true, val: 'valD' });

  // Delete and clear
  cache.delete('c');
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('ExpiryCache: expires entries past TTL', async () => {
  const cache = new ExpiryCache<string>(20, 10); // 20ms TTL
  cache.set('key', 'fresh');
  assert.deepEqual(cache.get('key'), { hit: true, val: 'fresh' });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(cache.get('key'), { hit: false, val: undefined });
});

test('fetchPlaneInfo: integrates aircraft and route data, with caching and fallback', async () => {
  aircraftCache.clear();
  routeCache.clear();

  let aircraftRequests = 0;
  let routeRequests = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/v0/aircraft/7c6b37') {
      aircraftRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: {
          aircraft: {
            type: 'A380-842',
            manufacturer: 'Airbus',
            registration: 'VH-OQA',
            registered_owner: 'Qantas',
          },
        },
      }));
    } else if (req.url === '/v0/callsign/QFA7') {
      routeRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: {
          flightroute: {
            airline: { name: 'Qantas' },
            origin: { iata_code: 'SYD' },
            destination: { iata_code: 'DFW' },
          },
        },
      }));
    } else if (req.url === '/v0/aircraft/000000') {
      aircraftRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'unknown aircraft' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Fetch full plane info
    const info = await fetchPlaneInfo('7C6B37', 'QFA7', baseUrl);
    assert.deepEqual(info, {
      type: 'A380-842',
      manufacturer: 'Airbus',
      registration: 'VH-OQA',
      owner: 'Qantas',
      airline: 'Qantas',
      origin: 'SYD',
      destination: 'DFW',
    });
    assert.equal(aircraftRequests, 1);
    assert.equal(routeRequests, 1);

    // 2. Fetch again -> should be served from memory cache (no new HTTP requests)
    const cachedInfo = await fetchPlaneInfo('7c6b37', 'qfa7', baseUrl);
    assert.deepEqual(cachedInfo, info);
    assert.equal(aircraftRequests, 1);
    assert.equal(routeRequests, 1);

    // 3. Unknown aircraft negative caching
    const unknown = await fetchPlaneInfo('000000', null, baseUrl);
    assert.deepEqual(unknown, {
      type: null,
      manufacturer: null,
      registration: null,
      owner: null,
      airline: null,
      origin: null,
      destination: null,
    });
    assert.equal(aircraftRequests, 2);

    // 4. Repeated unknown -> cached negative result
    const cachedUnknown = await fetchPlaneInfo('000000', null, baseUrl);
    assert.deepEqual(cachedUnknown, unknown);
    assert.equal(aircraftRequests, 2); // No new request
  } finally {
    server.close();
  }
});

test('mergeAircraft: one aircraft per hex, first feed wins, failed feeds skipped', () => {
  const lol = [{ hex: '7C7BF3', flight: 'YRP' }, { hex: '7c0001' }];
  const fi = [{ hex: '7c7bf3', flight: 'OTHER' }, { hex: '7c0002' }];
  const merged = mergeAircraft([lol, null, fi]);
  assert.deepEqual(merged.map((a) => a.hex), ['7C7BF3', '7c0001', '7c0002']);
  assert.equal(merged[0].flight, 'YRP');
  assert.deepEqual(mergeAircraft([null, null]), []);
});
