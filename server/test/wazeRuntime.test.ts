import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { presentWazeSetup, FIRST_RUN_MESSAGE } from '../src/wazeRuntime.js';
import { fetchWazeWorkerHealth } from '../src/feeds/waze.js';

const HOW = 'Waze needs its first-run screen completed once. On the machine running the worker, run: adb connect 127.0.0.1:5556';
const idle = { state: 'starting', message: 'Waiting for Waze reports', updatedAt: 1 };
const waiting = { state: 'needs_first_run', message: 'Waze needs its one-time first-run screen', updatedAt: 2, first_run: { how: HOW } };

test('a worker waiting on its welcome screen maps to needs_first_run; instructions reach admins only', () => {
  const health = { setupStage: 'needs_first_run', firstRun: { detectedAt: 1234, how: HOW } };
  const admin = presentWazeSetup(idle, health, { admin: true });
  assert.equal(admin.state, 'needs_first_run');
  assert.equal(admin.message, FIRST_RUN_MESSAGE);
  assert.deepEqual(admin.first_run, { detected_at: 1234, how: HOW });

  const visitor = presentWazeSetup(idle, health);
  assert.equal(visitor.state, 'needs_first_run');
  assert.deepEqual(visitor.first_run, { detected_at: 1234 });
  assert.equal(JSON.stringify(visitor).includes('adb connect'), false, 'visitors never receive operator instructions');
});

test('a saved needs_first_run record keeps its instructions for admins while the worker is unreachable', () => {
  assert.equal(presentWazeSetup(waiting, null, { admin: true }).first_run?.how, HOW);
  assert.equal(presentWazeSetup(waiting, null).first_run?.how, undefined);
});

test('once the worker has moved past its welcome screen, a stale saved record stops asking for a person', () => {
  const view = presentWazeSetup(waiting, { setupStage: 'connecting_waze', firstRun: null }, { admin: true });
  assert.equal(view.state, 'starting');
  assert.equal(view.first_run, undefined);
});

test('other setup states pass through unchanged and carry no first-run data', () => {
  const failed = { state: 'failed', message: 'Waze has not returned reports yet', updatedAt: 3 };
  assert.deepEqual(presentWazeSetup(failed, { setupStage: 'connecting_waze', firstRun: null }, { admin: true }),
    { state: 'failed', message: 'Waze has not returned reports yet', updatedAt: 3 });
  assert.deepEqual(presentWazeSetup({ state: 'not_started', message: 'Waze report setup has not run', updatedAt: null }, null),
    { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null });
});

test('worker health is read from /health without sending the API key or moving the emulator', async () => {
  const savedUrl = process.env.WAZE_ALERT_SERVICE_URL;
  process.env.WAZE_ALERT_SERVICE_URL = 'http://bridge.test/alerts';
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ setup_stage: 'needs_first_run', first_run: { detected_at: 99, how: HOW }, alerts: [] }));
  };
  try {
    const health = await fetchWazeWorkerHealth(fetcher);
    assert.deepEqual(health, { setupStage: 'needs_first_run', firstRun: { detectedAt: 99, how: HOW } });
    assert.equal(requests[0].url, 'http://bridge.test/health');
    assert.equal(requests[0].headers.get('X-API-Key'), null);
  } finally {
    if (savedUrl === undefined) delete process.env.WAZE_ALERT_SERVICE_URL; else process.env.WAZE_ALERT_SERVICE_URL = savedUrl;
  }
});

test('health probes ignore unconfigured, failed and malformed responses', async () => {
  const savedUrl = process.env.WAZE_ALERT_SERVICE_URL;
  try {
    delete process.env.WAZE_ALERT_SERVICE_URL;
    assert.equal(await fetchWazeWorkerHealth(async () => new Response('{}')), null);
    process.env.WAZE_ALERT_SERVICE_URL = 'http://bridge.test/alerts';
    assert.equal(await fetchWazeWorkerHealth(async () => new Response('{}', { status: 503 })), null);
    const malformed = await fetchWazeWorkerHealth(async () => new Response(JSON.stringify({ setup_stage: 7, first_run: { how: 9, detected_at: 'x' } })));
    assert.deepEqual(malformed, { setupStage: null, firstRun: { detectedAt: null, how: null } });
  } finally {
    if (savedUrl === undefined) delete process.env.WAZE_ALERT_SERVICE_URL; else process.env.WAZE_ALERT_SERVICE_URL = savedUrl;
  }
});
