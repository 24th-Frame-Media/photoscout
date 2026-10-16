import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ WAZE_ALERT_SERVICE_URL: 'http://bridge.test/alerts', WAZE_HARVESTER_API_KEY: 'test-key' });
after(() => app.close());
// The database is the app's own singleton, so it is imported only once the harness has pointed DATA_DIR at a temp folder.
const { db } = await import('../src/db.js');

// The Android bridge is the one outside service here: answer it, and let every other request through.
const realFetch = globalThis.fetch;
let bridgeCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'bridge.test') return realFetch(input, init);
  bridgeCalls++;
  const now = Date.now();
  return new Response(JSON.stringify({
    alerts: [
      { id: 'police-1', type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA', point: [151.2, -33.9], reportTime: now, thumbsUp: 2 },
      { id: 'hazard-1', type: 'HAZARD', point: [151.25, -33.85], reportTime: now },
      { id: 'police-far', type: 'POLICE', point: [149.5, -33.4], reportTime: now },
    ],
    coverage: 'viewport', observedAt: now, mock: false, connected: true, state: 'fresh',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
after(() => { globalThis.fetch = realFetch; });

const anon = app.client();
// The harness runs the app with public reads on, so alerts and the heatmap are open to anyone (auth.ts ANONYMOUS_READS);
// on a private instance both need a session (see accessHttp.test.ts).
const member = app.client();
await app.signIn(member, 'google', { id: '111', name: 'Alice' });
const box = 'minLng=151.1&minLat=-33.95&maxLng=151.3&maxLat=-33.8';

test('the alerts route records only the police reports of a fresh scan, and a cache hit records nothing', async () => {
  const first = await anon('GET', `/api/waze/alerts?${box}`);
  assert.equal(first.status, 200);
  assert.equal(first.json.configured, true);
  assert.equal(first.json.fromCache, false);
  assert.equal(first.json.alerts.length, 2);
  const again = await anon('GET', `/api/waze/alerts?${box}`);
  assert.equal(again.json.fromCache, true);
  assert.equal(bridgeCalls, 1, 'the second poll is served from the cache');
  const ids = (db.handle.prepare('SELECT id FROM waze_police_sightings').all() as { id: string }[]).map(r => r.id);
  assert.deepEqual(ids, ['police-1']);
});

test('the heatmap answers from the database with weighted points inside the box, without asking the bridge', async () => {
  const before = bridgeCalls;
  const visitor = await anon('GET', `/api/waze/heatmap?${box}`);
  assert.equal(visitor.status, 200, 'public reads are on, so a visitor sees the heatmap like the pins');
  const res = await member('GET', `/api/waze/heatmap?${box}`);
  assert.deepEqual(visitor.json.points.map((p: { point: number[] }) => p.point), res.json.points.map((p: { point: number[] }) => p.point), 'signing in does not change which reports are seen');
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, true);
  assert.equal(res.json.windowMs, 7200000);
  assert.equal(typeof res.json.observedAt, 'number');
  assert.equal(res.json.points.length, 1);
  assert.deepEqual(res.json.points[0].point, [151.2, -33.9]);
  // Two thumbs-up, seen just now: (1 + 2) x just under 1.
  assert.ok(res.json.points[0].weight > 2.99 && res.json.points[0].weight <= 3, `weight ${res.json.points[0].weight}`);
  assert.equal(bridgeCalls, before);
});

test('the heatmap window is clamped to one hour to seven days, and defaults to two hours', async () => {
  const windowOf = async (extra: string) => (await member('GET', `/api/waze/heatmap?${box}${extra}`)).json.windowMs;
  assert.equal(await windowOf('&windowMs=1'), 3600000);
  assert.equal(await windowOf('&windowMs=86400000'), 86400000);
  assert.equal(await windowOf('&windowMs=99999999999'), 604800000);
  assert.equal(await windowOf('&windowMs=abc'), 7200000);
  assert.equal(await windowOf('&windowMs='), 7200000);
  assert.equal(await windowOf(''), 7200000);
});

test('the heatmap rejects a missing or invalid box', async () => {
  assert.equal((await member('GET', '/api/waze/heatmap?minLng=151')).status, 400);
  assert.equal((await member('GET', '/api/waze/heatmap?minLng=151.3&minLat=-33.95&maxLng=151.1&maxLat=-33.8')).status, 400);
  assert.equal((await member('GET', '/api/waze/heatmap?minLng=151.1&minLat=-33.95&maxLng=181&maxLat=-33.8')).status, 400);
});
