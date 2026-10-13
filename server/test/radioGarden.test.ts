import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import {
  isValidRadioId,
  getProviderListenUrl,
  parseRadioPlaces,
  parseRadioStations,
  fetchRadioPlaces,
  fetchRadioStations,
  RadioProviderError,
  RADIO_PLACES_KEY,
} from '../src/sources/radioGarden.js';

test('isValidRadioId: accepts safe tokens, rejects traversal/injection/arbitrary URLs', () => {
  assert.equal(isValidRadioId('9Yi25umJ'), true);
  assert.equal(isValidRadioId('LWYfKJRw'), true);
  assert.equal(isValidRadioId('-zbf9OrG'), true);
  assert.equal(isValidRadioId('7lB_w81I'), true);

  // Rejected invalid IDs
  assert.equal(isValidRadioId(''), false);
  assert.equal(isValidRadioId('../secret'), false);
  assert.equal(isValidRadioId('foo/bar'), false);
  assert.equal(isValidRadioId('https://evil.com'), false);
  assert.equal(isValidRadioId('id?query=1'), false);
  assert.equal(isValidRadioId('has space'), false);
  assert.equal(isValidRadioId(null), false);
  assert.equal(isValidRadioId(undefined), false);
  assert.equal(isValidRadioId(123), false);
});

test('getProviderListenUrl: resolves only safe channel IDs, throws on invalid', () => {
  assert.equal(
    getProviderListenUrl('LWYfKJRw'),
    'https://radio.garden/api/ara/content/listen/LWYfKJRw/channel.mp3'
  );

  assert.throws(
    () => getProviderListenUrl('../malicious/path'),
    (err: any) => err instanceof RadioProviderError && err.status === 400
  );
});

test('parseRadioPlaces: normalises valid places and defends against malformed rows', () => {
  const raw = {
    apiVersion: 1,
    data: {
      list: [
        {
          id: '8bpgLLGQ',
          title: 'Canning',
          country: 'Argentina',
          geo: [-58.51272, -34.884495],
          size: 1,
        },
        {
          id: '9Yi25umJ',
          title: 'New York NY',
          country: 'United States',
          geo: [-74.005974, 40.712776],
          size: 183,
        },
        // Missing ID
        {
          title: 'No ID',
          country: 'Nowhere',
          geo: [10, 20],
        },
        // Invalid coordinate (latitude out of range)
        {
          id: 'invalid-lat',
          title: 'Bad Lat',
          country: 'Nowhere',
          geo: [10, 100],
        },
        // Invalid coordinate (longitude out of range)
        {
          id: 'invalid-lng',
          title: 'Bad Lng',
          country: 'Nowhere',
          geo: [-190, 10],
        },
        // Missing title
        {
          id: 'no-title',
          title: '   ',
          country: 'Nowhere',
          geo: [10, 20],
        },
        // Non-array geo
        {
          id: 'bad-geo',
          title: 'Bad Geo',
          country: 'Nowhere',
          geo: 'not-an-array',
        },
        // Malformed row
        null,
        'not an object',
      ],
    },
  };

  const places = parseRadioPlaces(raw);
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], {
    id: '8bpgLLGQ',
    title: 'Canning',
    country: 'Argentina',
    lng: -58.51272,
    lat: -34.884495,
    stationCount: 1,
  });
  assert.deepEqual(places[1], {
    id: '9Yi25umJ',
    title: 'New York NY',
    country: 'United States',
    lng: -74.005974,
    lat: 40.712776,
    stationCount: 183,
  });

  // Empty/corrupt inputs return empty array without crashing
  assert.deepEqual(parseRadioPlaces(null), []);
  assert.deepEqual(parseRadioPlaces({}), []);
  assert.deepEqual(parseRadioPlaces({ data: { list: null } }), []);
});

test('parseRadioStations: parses nested stations, deduplicates channels, and assigns listen endpoints', () => {
  const raw = {
    apiVersion: 1,
    data: {
      type: 'page',
      title: 'New York NY',
      subtitle: 'United States',
      content: [
        {
          type: 'list',
          itemsType: 'channel',
          title: 'Stations in New York NY',
          items: [
            {
              page: {
                type: 'channel',
                url: '/listen/code-radio/LWYfKJRw',
                title: 'Code Radio',
                stream: 'freecodecamp.org',
                place: { id: '9Yi25umJ', title: 'New York NY' },
              },
            },
            {
              page: {
                type: 'channel',
                url: '/listen/hot-97-1/5AJGqjWN',
                title: 'Hot 97.1',
                stream: 'streamtheworld.com',
                place: { id: '9Yi25umJ', title: 'New York NY' },
              },
            },
            // Malformed item
            { page: null },
            // Missing title
            { page: { type: 'channel', url: '/listen/foo/bar123', title: '' } },
            // Invalid channel ID
            { page: { type: 'channel', url: '/listen/foo/bad..id', title: 'Bad' } },
          ],
        },
        {
          type: 'list',
          itemsType: 'channel',
          title: 'Popular in New York NY',
          items: [
            // Duplicate of Code Radio: must be deduplicated
            {
              page: {
                type: 'channel',
                url: '/listen/code-radio/LWYfKJRw',
                title: 'Code Radio',
                stream: 'freecodecamp.org',
              },
            },
            {
              page: {
                type: 'channel',
                url: '/listen/wnyc/38SmGFvr',
                title: 'WNYC 93.9 FM',
                stream: 'wnyc.org',
              },
            },
          ],
        },
        {
          type: 'list',
          itemsType: undefined,
          title: 'Nearby Places',
          items: [
            {
              page: {
                type: 'place',
                url: '/visit/jersey-city/Mz92V7mI',
                title: 'Jersey City NJ',
              },
            },
          ],
        },
      ],
    },
  };

  const result = parseRadioStations(raw, '9Yi25umJ');
  assert.equal(result.placeId, '9Yi25umJ');
  assert.equal(result.title, 'New York NY');
  assert.equal(result.country, 'United States');
  assert.equal(result.stations.length, 3); // Code Radio, Hot 97.1, WNYC (duplicate dropped)

  assert.deepEqual(result.stations[0], {
    id: 'LWYfKJRw',
    title: 'Code Radio',
    placeId: '9Yi25umJ',
    streamDomain: 'freecodecamp.org',
    listenUrl: '/api/radio/stations/LWYfKJRw/listen',
  });
  assert.deepEqual(result.stations[1], {
    id: '5AJGqjWN',
    title: 'Hot 97.1',
    placeId: '9Yi25umJ',
    streamDomain: 'streamtheworld.com',
    listenUrl: '/api/radio/stations/5AJGqjWN/listen',
  });
  assert.deepEqual(result.stations[2], {
    id: '38SmGFvr',
    title: 'WNYC 93.9 FM',
    placeId: '9Yi25umJ',
    streamDomain: 'wnyc.org',
    listenUrl: '/api/radio/stations/38SmGFvr/listen',
  });
});

test('fetchRadioPlaces: caches for 24h and serves stale cache when refresh fails', async () => {
  const db = createDb(':memory:');

  const fixture = {
    data: {
      list: [
        { id: 'place1', title: 'Sydney', country: 'Australia', geo: [151.2, -33.8], size: 10 },
      ],
    },
  };

  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // 1. First call fetches fresh and caches
  const first = await fetchRadioPlaces(db, { fetchFn: mockFetch });
  assert.equal(first.length, 1);
  assert.equal(first[0].title, 'Sydney');
  assert.equal(callCount, 1);

  // 2. Second call within TTL hits cache (mockFetch not called)
  const second = await fetchRadioPlaces(db, { fetchFn: mockFetch });
  assert.equal(second.length, 1);
  assert.equal(second[0].title, 'Sydney');
  assert.equal(callCount, 1);

  // 3. Forcing refresh when upstream fails serves stale data from cache
  const failingFetch: typeof fetch = async () => {
    callCount++;
    throw new Error('Network outage');
  };

  const staleResult = await fetchRadioPlaces(db, { forceRefresh: true, fetchFn: failingFetch });
  assert.equal(staleResult.length, 1);
  assert.equal(staleResult[0].title, 'Sydney');
  assert.equal(callCount, 2);

  // 4. In a clean DB with no cache, an outage throws RadioProviderError(503)
  const cleanDb = createDb(':memory:');
  await assert.rejects(
    () => fetchRadioPlaces(cleanDb, { fetchFn: failingFetch }),
    (err: any) => err instanceof RadioProviderError && err.status === 503
  );
});

test('fetchRadioStations: caches stations, validates IDs, and handles errors', async () => {
  const db = createDb(':memory:');

  // Invalid ID format rejected before any network request
  await assert.rejects(
    () => fetchRadioStations(db, '../evil'),
    (err: any) => err instanceof RadioProviderError && err.status === 400
  );

  const fixture = {
    data: {
      title: 'Sydney',
      subtitle: 'Australia',
      content: [
        {
          itemsType: 'channel',
          items: [
            {
              page: {
                type: 'channel',
                url: '/listen/fbi-radio/fbi12345',
                title: 'FBi Radio',
                stream: 'fbiradio.com',
              },
            },
          ],
        },
      ],
    },
  };

  let callCount = 0;
  const mockFetch: typeof fetch = async () => {
    callCount++;
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Fresh fetch and cache
  const stations = await fetchRadioStations(db, 'syd123', { fetchFn: mockFetch });
  assert.equal(stations.stations.length, 1);
  assert.equal(stations.stations[0].title, 'FBi Radio');
  assert.equal(callCount, 1);

  // Cached hit
  const cached = await fetchRadioStations(db, 'syd123', { fetchFn: mockFetch });
  assert.equal(cached.stations.length, 1);
  assert.equal(callCount, 1);

  // 404 from upstream gives 404 error
  const notFoundFetch: typeof fetch = async () => {
    return new Response('Not found', { status: 404 });
  };
  await assert.rejects(
    () => fetchRadioStations(db, 'unknown_place', { fetchFn: notFoundFetch }),
    (err: any) => err instanceof RadioProviderError && err.status === 404
  );
});
