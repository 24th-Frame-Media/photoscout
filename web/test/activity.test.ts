import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFetch, activityService, activitySnapshot, clearActivity, logActivity, logSuccessIfNews } from '../src/activity.js';

// Each test below uses services no other test touches, because the page session (which services have loaded
// or failed) lasts for the whole file.

test('history is bounded and repeated service polls are grouped', () => {
  clearActivity();
  logActivity('Trains', 'Updated', 'success');
  logActivity('Weather', 'Updated', 'success');
  logActivity('Trains', 'Updated', 'success');
  assert.equal(activitySnapshot().length, 2);
  assert.equal(activitySnapshot()[0].repeats, 2);
  for (let i = 0; i < 100; i++) logActivity('Service', String(i));
  assert.equal(activitySnapshot().length, 80);
});

test('services are identified without storing locations, tokens or private URLs', () => {
  assert.equal(activityService('/api/planes?lat=12&lng=34'), 'Flights');
  assert.equal(activityService('/api/events-admin/crawler/status'), 'Crawler');
  assert.equal(activityService('/api/events-admin/density/Sydney'), 'Busy places');
  assert.equal(activityService('/api/events-admin/llm/status'), 'AI models');
  assert.equal(activityService('/api/events-admin/notify/status'), 'Notifications');
  assert.equal(activityService('/api/events-admin/tasks'), 'Scheduled tasks');
  assert.equal(activityService('/api/auth-config/google'), null);
  assert.equal(activityService('/api/shares/private-token'), null);
});

test('aborted requests do not become service failures', async () => {
  clearActivity();
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); throw new Error('aborted'); };
  try {
    await assert.rejects(activityFetch('/api/weather?lat=12', { signal: controller.signal }));
    assert.equal(activitySnapshot().some(entry => entry.level === 'error'), false);
  } finally { globalThis.fetch = original; }
});

test('an older area response cannot overwrite the newest service outcome', async () => {
  clearActivity();
  const original = globalThis.fetch;
  let release!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : new Response('{}', { status: 503 });
  try {
    const oldArea = activityFetch('/api/planes?lat=1');
    await activityFetch('/api/planes?lat=2');
    release(new Response('[]'));
    await oldArea;
    assert.equal(activitySnapshot()[0].level, 'error');
    assert.equal(activitySnapshot()[0].service, 'Flights');
    assert.equal(JSON.stringify(activitySnapshot()).includes('lat='), false);
  } finally { globalThis.fetch = original; }
});

test('an unconfigured feed is not reported as a working service after HTTP 200', async () => {
  clearActivity();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ configured: false, cameras: [], privateValue: 'not-for-the-log' });
  try {
    const response = await activityFetch('/api/cameras');
    assert.equal(activitySnapshot()[0].level, 'warning');
    assert.equal(activitySnapshot()[0].message, 'Needs configuration in Settings');
    assert.equal(JSON.stringify(activitySnapshot()).includes('not-for-the-log'), false);
    assert.equal((await response.json()).configured, false, 'logging must not consume the caller response');
  } finally { globalThis.fetch = original; }
});

test('routine successes are not logged, but a first load is, and clearing the list does not make them news again', async () => {
  clearActivity();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([]);
  try {
    await activityFetch('/api/aurora?lat=1');
    await activityFetch('/api/aurora?lat=1');
    await activityFetch('/api/aurora?lat=2');
    const aurora = activitySnapshot().filter(entry => entry.service === 'Aurora');
    assert.equal(aurora.length, 1, 'three successful polls leave one entry');
    assert.deepEqual([aurora[0].level, aurora[0].message], ['success', 'Loaded']);
    assert.equal(activitySnapshot().some(entry => entry.message === 'Loading…'), false, 'the old per-request Loading line is gone');
    clearActivity();
    await activityFetch('/api/aurora?lat=3');
    assert.equal(activitySnapshot().length, 0, 'a service that has loaded this session is not news again after Clear list');
  } finally { globalThis.fetch = original; }
});

test('a success right after a failure is recorded as working again, and the next success is not', async () => {
  clearActivity();
  const original = globalThis.fetch;
  let reply = () => new Response('{}', { status: 503 });
  globalThis.fetch = async () => reply();
  try {
    await activityFetch('/api/rail?route=a');
    reply = () => new Response('[]');
    await activityFetch('/api/rail?route=a');
    await activityFetch('/api/rail?route=a');
    const rail = activitySnapshot().filter(entry => entry.service === 'Rail network');
    assert.deepEqual(rail.map(entry => [entry.level, entry.message]), [['success', 'Working again'], ['error', 'Unavailable right now; try again later']]);
  } finally { globalThis.fetch = original; }
});

test('a slow successful request is logged as an info entry; a quick one is not', async () => {
  clearActivity();
  const original = globalThis.fetch;
  let now = 1_000_000;
  const clock = mock.method(Date, 'now', () => now);
  try {
    globalThis.fetch = async () => { now += 5_000; return Response.json([]); };
    await activityFetch('/api/marine?lat=1');
    const slow = activitySnapshot().filter(entry => entry.message.startsWith('Loaded slowly'));
    assert.equal(slow.length, 1);
    assert.deepEqual([slow[0].service, slow[0].level, slow[0].message], ['Tides and swell', 'info', 'Loaded slowly (5 s)']);
    globalThis.fetch = async () => { now += 3_000; return Response.json([]); };
    await activityFetch('/api/marine?lat=1');
    assert.equal(activitySnapshot().filter(entry => entry.message.startsWith('Loaded slowly')).length, 1, 'a 3 s load is not slow');
  } finally { clock.mock.restore(); globalThis.fetch = original; }
});

test('failures and warnings are always recorded, including after a success', async () => {
  clearActivity();
  const original = globalThis.fetch;
  let reply: () => Response = () => new Response('[]');
  globalThis.fetch = async () => reply();
  try {
    await activityFetch('/api/geocode?q=a');
    reply = () => new Response('{}', { status: 503 });
    await activityFetch('/api/geocode?q=b');
    await activityFetch('/api/geocode?q=c');
    reply = () => new Response('{}', { status: 429 });
    await activityFetch('/api/spots');
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(activityFetch('/api/routes'));
    const named = (service: string) => activitySnapshot().filter(entry => entry.service === service);
    assert.deepEqual(named('Place search').map(entry => [entry.level, entry.repeats]), [['error', 2], ['success', 1]]);
    assert.deepEqual([named('Spots')[0].level, named('Spots')[0].message], ['warning', 'Busy; try again shortly']);
    assert.deepEqual([named('Routes')[0].level, named('Routes')[0].message], ['error', 'Connection failed']);
  } finally { globalThis.fetch = original; }
});

test('logSuccessIfNews: a routine refresh is news once, and again after a failure', () => {
  clearActivity();
  assert.equal(logSuccessIfNews('Rain radar', 'Radar frames updated'), true);
  assert.equal(logSuccessIfNews('Rain radar', 'Radar frames updated'), false);
  logActivity('Rain radar', 'Radar frames unavailable', 'error');
  assert.equal(logSuccessIfNews('Rain radar', 'Radar frames updated'), true);
  assert.deepEqual(activitySnapshot().filter(entry => entry.service === 'Rain radar').map(entry => [entry.level, entry.message]), [
    ['success', 'Working again'], ['error', 'Radar frames unavailable'], ['success', 'Radar frames updated'],
  ]);
});
