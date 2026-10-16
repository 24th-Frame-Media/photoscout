import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetWazeCache, fetchWazeAlertsCached, WAZE_CACHE_TTL_MS } from '../src/feeds/waze.js';

const bbox = { minLng: 151.12, minLat: -33.93, maxLng: 151.28, maxLat: -33.82 };
// The same grid cells as bbox, so a pan inside them must reuse its scan.
const pannedWithinCells = { minLng: 151.13, minLat: -33.92, maxLng: 151.27, maxLat: -33.83 };
let savedUrl: string | undefined, savedKey: string | undefined;
beforeEach(() => {
  savedUrl = process.env.WAZE_ALERT_SERVICE_URL; savedKey = process.env.WAZE_HARVESTER_API_KEY;
  process.env.WAZE_ALERT_SERVICE_URL = 'http://bridge.test/alerts';
  process.env.WAZE_HARVESTER_API_KEY = 'test-key';
  __resetWazeCache();
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.WAZE_ALERT_SERVICE_URL; else process.env.WAZE_ALERT_SERVICE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.WAZE_HARVESTER_API_KEY; else process.env.WAZE_HARVESTER_API_KEY = savedKey;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fresh = (alerts: unknown[] = []) => ({ alerts, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh' });

/** A harvester that answers with `reply(callNumber)` and records every URL it was asked for. */
function harvester(reply: (call: number) => Response = () => json(fresh())) {
  const urls: URL[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(new URL(String(input)));
    return reply(urls.length);
  };
  return { fetchFn, urls };
}

test('overlapping map polls within the TTL share one harvester scan', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester();
  const first = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  const second = await fetchWazeAlertsCached(pannedWithinCells, { now: t0 + 1000, fetchFn });
  assert.equal(urls.length, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.observedAt, first.observedAt, 'a cache hit keeps the harvester observation time');
  assert.equal(second.state, 'fresh');
});

test('the harvester is asked for the grid cells around the box, with map priority', async () => {
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(bbox, { now: Date.now(), fetchFn });
  const q = urls[0].searchParams;
  assert.equal(q.get('minLng'), '151.1');
  assert.equal(q.get('minLat'), '-33.95');
  assert.equal(q.get('maxLng'), '151.3');
  assert.equal(q.get('maxLat'), '-33.8');
  assert.equal(q.get('priority'), 'map');
});

test('a box already on the grid is not widened by a cell', async () => {
  const onGrid = { minLng: 151.1, minLat: -33.95, maxLng: 151.3, maxLat: -33.8 };
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(onGrid, { now: Date.now(), fetchFn });
  assert.equal(urls[0].searchParams.get('maxLng'), '151.3');
  assert.equal(urls[0].searchParams.get('maxLat'), '-33.8');
  assert.equal(urls[0].searchParams.get('minLng'), '151.1');
});

test('after the TTL the harvester is asked again', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  const justBefore = await fetchWazeAlertsCached(bbox, { now: t0 + WAZE_CACHE_TTL_MS - 1, fetchFn });
  assert.equal(justBefore.fromCache, true);
  assert.equal(urls.length, 1);
  const atTtl = await fetchWazeAlertsCached(bbox, { now: t0 + WAZE_CACHE_TTL_MS, fetchFn });
  assert.equal(atTtl.fromCache, false);
  assert.equal(urls.length, 2);
});

test('navigation always asks the harvester and never fills the cache', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester();
  const a = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn, priority: 'navigation' });
  const b = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn, priority: 'navigation' });
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, false);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('priority'), 'navigation');
  // The navigation scans stored nothing, so the first map poll still has to scan.
  const map = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  assert.equal(map.fromCache, false);
  assert.equal(urls.length, 3);
  const mapAgain = await fetchWazeAlertsCached(bbox, { now: t0 + 1, fetchFn });
  assert.equal(mapAgain.fromCache, true);
  assert.equal(urls.length, 3);
});

test('a navigation request is not answered from a map cache entry', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  const nav = await fetchWazeAlertsCached(bbox, { now: t0 + 1, fetchFn, priority: 'navigation' });
  assert.equal(nav.fromCache, false);
  assert.equal(urls.length, 2);
});

test('queued and scanning results are returned but not cached, so the next poll asks again', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester((call) => call === 1
    ? json({ alerts: [], state: 'queued', observedAt: null, mock: false, queuePosition: 2 }, 202)
    : json(fresh()));
  const queued = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.observedAt, null);
  assert.equal(queued.fromCache, false);
  const next = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  assert.equal(next.state, 'fresh');
  assert.equal(next.fromCache, false);
  assert.equal(urls.length, 2);
  const hit = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  assert.equal(hit.fromCache, true);
  assert.equal(urls.length, 2);
});

test('stale results are cached with their original observation time', async () => {
  const t0 = Date.now();
  const observedAt = t0 - 200000;
  const { fetchFn, urls } = harvester(() => json({ ...fresh(), state: 'stale', observedAt }));
  const first = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  const again = await fetchWazeAlertsCached(bbox, { now: t0 + 1000, fetchFn });
  assert.equal(first.state, 'stale');
  assert.equal(again.fromCache, true);
  assert.equal(again.observedAt, observedAt);
  assert.equal(urls.length, 1);
});

test('a failed harvester call is thrown, not cached', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester((call) => call === 1 ? json({}, 503) : json(fresh()));
  await assert.rejects(fetchWazeAlertsCached(bbox, { now: t0, fetchFn }), /HTTP 503/);
  const recovered = await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  assert.equal(recovered.fromCache, false);
  assert.equal(urls.length, 2);
});

test('different priorities or distant boxes do not share an entry', async () => {
  const t0 = Date.now();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(bbox, { now: t0, fetchFn });
  await fetchWazeAlertsCached({ minLng: 149.0, minLat: -34.5, maxLng: 149.2, maxLat: -34.3 }, { now: t0, fetchFn });
  assert.equal(urls.length, 2);
});

test('invalid bounds are rejected before anything is fetched', async () => {
  const { fetchFn, urls } = harvester();
  await assert.rejects(fetchWazeAlertsCached({ ...bbox, minLat: NaN }, { fetchFn }));
  assert.equal(urls.length, 0);
});
