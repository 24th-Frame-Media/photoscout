import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

test('report HTTP routes preserve pending/error states, gate setup and reserve navigation priority for members', async () => {
  const h = await startApp({ WAZE_ALERT_SERVICE_URL: 'http://reports.test/alerts', WAZE_HARVESTER_API_KEY: 'test-key' });
  const previousFetch = globalThis.fetch;
  const requested: URL[] = [];
  let mode: 'pending' | 'fresh' | 'mock' = 'pending';
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'reports.test') return previousFetch(input, init);
    requested.push(url);
    assert.equal(new Headers(init?.headers).get('X-API-Key'), 'test-key');
    return new Response(JSON.stringify(mode === 'pending'
      ? { alerts: [], state: 'queued', observedAt: null, mock: false }
      : { alerts: [], coverage: 'viewport', observedAt: Date.now(), mock: mode === 'mock', connected: true }), { status: mode === 'pending' ? 202 : 200 });
  };
  try {
    const visitor = h.client(), member = h.client();
    await h.signIn(member, 'google', { id: 'report-member', name: 'Report member' });
    assert.equal((await member('GET', '/api/auth/status')).json.authed, true);
    const bounds = 'minLng=151.1&minLat=-33.95&maxLng=151.3&maxLat=-33.8';
    for (const query of ['', 'minLng=&minLat=-34&maxLng=152&maxLat=-33', 'minLng=151&minLng=152&minLat=-34&maxLng=153&maxLat=-33']) {
      assert.equal((await visitor('GET', `/api/waze/alerts?${query}`)).status, 400);
    }
    assert.equal(requested.length, 0);
    const queued = await visitor('GET', `/api/waze/alerts?${bounds}&priority=navigation`);
    assert.equal(queued.status, 200); assert.equal(queued.json.state, 'queued'); assert.equal(queued.json.observedAt, null);
    assert.equal(requested.at(-1)!.searchParams.get('priority'), 'map');
    await member('GET', `/api/waze/alerts?${bounds}&priority=navigation`);
    assert.equal(requested.at(-1)!.searchParams.get('priority'), 'navigation');
    assert.equal((await visitor('POST', '/api/waze/setup', {})).status, 401);
    assert.equal((await member('POST', '/api/waze/setup', {})).status, 403);
    mode = 'fresh';
    const unchecked = await visitor('GET', '/api/waze/status');
    assert.equal(unchecked.json.checked, false); assert.equal(unchecked.json.liveMapStatus.status, null);
    const status = await visitor('GET', '/api/waze/status?check=1');
    assert.equal(status.json.canDisplayOnMap, true);
    assert.equal(requested.at(-1)!.search, '', 'checking status must not move the emulator');
    mode = 'mock';
    const failed = await visitor('GET', `/api/waze/alerts?${bounds}`);
    assert.equal(failed.status, 503); assert.equal(failed.json.configured, false);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
