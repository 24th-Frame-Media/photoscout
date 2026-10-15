import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWazeAlerts, validateWazeBounds } from '../src/feeds/waze.js';
const bbox = { minLng: 151.1, minLat: -33.95, maxLng: 151.3, maxLat: -33.8 };
let savedUrl: string | undefined, savedKey: string | undefined;
beforeEach(() => {
  savedUrl = process.env.WAZE_ALERT_SERVICE_URL; savedKey = process.env.WAZE_HARVESTER_API_KEY;
  process.env.WAZE_ALERT_SERVICE_URL = 'http://bridge.test/alerts';
  process.env.WAZE_HARVESTER_API_KEY = 'test-key';
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.WAZE_ALERT_SERVICE_URL; else process.env.WAZE_ALERT_SERVICE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.WAZE_HARVESTER_API_KEY; else process.env.WAZE_HARVESTER_API_KEY = savedKey;
});
const response = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const fresh = (alerts: unknown[] = []) => ({ alerts, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true });

test('report bounds reject missing, reversed and non-geographic coordinates', () => {
  for (const invalid of [{ ...bbox, minLng: NaN }, { ...bbox, maxLat: 91 }, { ...bbox, minLat: 34 }, { ...bbox, minLng: -181 }]) assert.throws(() => validateWazeBounds(invalid));
  assert.doesNotThrow(() => validateWazeBounds(bbox));
});
test('map requests carry bounds and priority; status checks do not move the worker', async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new URL(String(input)));
    assert.equal(new Headers(init?.headers).get('X-API-Key'), 'test-key');
    return new Response(JSON.stringify(fresh()));
  };
  await fetchWazeAlerts(bbox, fetcher, true, 'navigation');
  await fetchWazeAlerts(bbox, fetcher, false);
  assert.equal(requests[0].searchParams.get('priority'), 'navigation');
  assert.equal(requests[0].searchParams.get('minLng'), '151.1');
  assert.equal(requests[1].search, '');
});
test('pending scans have no observation time and cannot masquerade as a fresh empty feed', async () => {
  const result = await fetchWazeAlerts(bbox, response({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202));
  assert.equal(result.state, 'queued'); assert.equal(result.observedAt, null);
  assert.equal(result.retryAfterMs, 5000);
});
test('mock, disconnected, stale, invalid and failed bridge responses remain failures', async () => {
  for (const body of [{ ...fresh(), mock: true }, { ...fresh(), connected: false }, { ...fresh(), observedAt: Date.now() - 200000 }, { ...fresh(), observedAt: null }, { ...fresh(), coverage: 'world' }]) {
    await assert.rejects(fetchWazeAlerts(bbox, response(body)));
  }
  await assert.rejects(fetchWazeAlerts(bbox, response({}, 503)), /HTTP 503/);
  await assert.rejects(fetchWazeAlerts(bbox, response({}, 429)), /HTTP 429/);
  delete process.env.WAZE_ALERT_SERVICE_URL;
  await assert.rejects(fetchWazeAlerts(bbox, response(fresh())), /Set up/);
});
test('area filtering and report field allowlist keep other locations and private metadata out', async () => {
  const result = await fetchWazeAlerts(bbox, response(fresh([
    { id: 'police', type: 'POLICE', point: [151.2, -33.9], subType: 'POLICE_MOBILE_CAMERA', street: 'Example', reporter: 'private', sessionToken: 'private', reportTime: null },
    { id: 'other-area', type: 'POLICE', point: [149.56, -33.42] },
    { id: 'bad', type: 'POLICE', point: ['151.2', -33.9] },
    { id: 'unknown', type: 'NEW_EVENT', point: [151.2, -33.9] },
  ])));
  assert.deepEqual(result.alerts, [{ id: 'police', type: 'POLICE', point: [151.2, -33.9], subType: 'POLICE_MOBILE_CAMERA', street: 'Example', reportTime: null }]);
});
test('cached stale reports stay marked stale and do not get a new observation time', async () => {
  const time = Date.now() - 200000;
  const result = await fetchWazeAlerts(bbox, response({ ...fresh(), state: 'stale', observedAt: time }));
  assert.equal(result.state, 'stale'); assert.equal(result.observedAt, time);
});
