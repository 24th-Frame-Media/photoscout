import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp();
const { eventSource } = await import('../src/events.js');
after(() => app.close());

/** What the engine answers with: everything it knows, including what must not get out. */
const upstream = (group: string, extra: Record<string, unknown> = {}) => ({
  group, title: `Event ${group}`, rawTitle: 'raw title', description: 'A description', rawDescription: 'raw <b>text</b>',
  startTime: '2030-01-05T09:00:00.000Z', endTime: null, venueName: 'The Venue', address: '1 Main St', locality: 'Bathurst',
  place: 'Bathurst', area: 'Bathurst', lat: -33.4, lng: 149.5, imageUrl: '/flyers/stored.jpg', images: ['/flyers/stored.jpg', 'https://img.test/a.jpg'],
  category: 'Motorsport', priceText: 'Free', isOnline: false, dateOnly: false, photoScore: 55, starred: true, hidden: false,
  firstSeenAt: null, culled: null, series: 'abc', note: 'gates open at 8',
  sources: [{ source: 'crawler', url: 'javascript:alert(1)' }, { source: 'crawler', url: 'https://listing.test/e/1' }, { source: 'facebook', url: 'https://fb.test/2' }],
  members: [{ id: 1, source: 'crawler', title: 'x', url: 'https://listing.test/e/1' }], edited: [], enriched: {},
  ...extra,
});
const FEED = [
  upstream('ok-1'),
  upstream('ok-2', { lat: null, lng: null, images: [], imageUrl: '', sources: [], starred: false }),
  upstream('cull-1', { culled: 'outside every area' }),
  upstream('hide-1', { hidden: true }),
];

// The engine, as far as the list can tell.
let upstreamCalls = 0;
let upstreamDown = false;
eventSource.read = () => {
  upstreamCalls++;
  if (upstreamDown) throw new Error('down');
  return FEED;
};

const alice = app.client();
const bob = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bob' });

test('a visitor can list events, which leave out what event-scout has hidden or culled, and only ever say so much', async () => {
  const anon = app.client();
  const first = await anon('GET', '/api/events');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.map((e: { group: string }) => e.group), ['ok-1', 'ok-2']);
  assert.deepEqual(Object.keys(first.json[0]).sort(), [
    'address', 'category', 'dateOnly', 'description', 'endTime', 'foundAt', 'going', 'group', 'hidden', 'imageUrl', 'interested', 'isOnline', 'lat', 'lng',
    'locality', 'myRsvp', 'photoScore', 'priceText', 'series', 'sources', 'starred', 'startTime', 'title', 'url', 'venueName',
  ]);
  const [ev, bare] = first.json;
  assert.equal(ev.imageUrl, 'https://img.test/a.jpg', 'a stored copy is a path on event-scout, not something a browser can load');
  assert.equal(ev.url, 'https://listing.test/e/1', 'one link, and not the javascript: one');
  assert.equal(ev.starred, false, "event-scout's own star is the admin's, not the visitor's");
  assert.deepEqual([bare.imageUrl, bare.url, bare.lat, bare.lng], ['', '', null, null]);
  assert.ok(!first.text.includes('raw <b>'), 'no raw text');
  assert.ok(!first.text.includes('fb.test'), 'no other source addresses');
  assert.ok(!first.text.includes('gates open'), 'no internal fields');
});

test('two lists inside a minute are one question to event-scout, and a later one asks again', async () => {
  // The first test already listed; this and the detail route are the same cache.
  assert.equal(upstreamCalls, 1);
  await app.client()('GET', '/api/events');
  await alice('GET', '/api/events');
  assert.equal((await bob('GET', '/api/events/ok-1')).status, 200);
  assert.equal(upstreamCalls, 1);

  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    mock.timers.tick(61_000);
    assert.equal((await app.client()('GET', '/api/events')).json.length, 2);
    assert.equal(upstreamCalls, 2);

    // Down, it is the last list that is served rather than an error.
    upstreamDown = true;
    mock.timers.tick(61_000);
    const stale = await app.client()('GET', '/api/events');
    assert.equal(stale.status, 200);
    assert.equal(stale.json.length, 2);
    assert.equal(upstreamCalls, 3);
    await app.client()('GET', '/api/events');
    assert.equal(upstreamCalls, 3, 'and it is not asked again for another minute');
  } finally {
    upstreamDown = false;
    mock.timers.reset();
  }
});

test('one event: found by its group, and not when event-scout has it out of sight', async () => {
  const anon = app.client();
  const ok = await anon('GET', '/api/events/ok-2');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.title, 'Event ok-2');
  for (const gone of ['cull-1', 'hide-1', 'nothing-like-it']) assert.equal((await anon('GET', `/api/events/${gone}`)).status, 404, gone);
});

test('starring and hiding are per person, need a session, and leave the rest of the list alone', async () => {
  const anon = app.client();
  assert.equal((await anon('PUT', '/api/events/ok-1/state', { starred: true })).status, 401);

  const starred = await alice('PUT', '/api/events/ok-1/state', { starred: true });
  assert.deepEqual(starred.json, { group: 'ok-1', starred: true, hidden: false });
  // A field left out keeps what it was.
  assert.deepEqual((await alice('PUT', '/api/events/ok-1/state', { hidden: true })).json, { group: 'ok-1', starred: true, hidden: true });
  assert.deepEqual((await alice('PUT', '/api/events/ok-1/state', { hidden: false })).json, { group: 'ok-1', starred: true, hidden: false });
  await bob('PUT', '/api/events/ok-2/state', { hidden: true });

  const marks = (r: { json: { group: string; starred: boolean; hidden: boolean }[] }) => r.json.map((e) => `${e.group}:${+e.starred}${+e.hidden}`);
  assert.deepEqual(marks(await alice('GET', '/api/events')), ['ok-1:10', 'ok-2:00']);
  assert.deepEqual(marks(await bob('GET', '/api/events')), ['ok-1:00', 'ok-2:01']);
  assert.deepEqual(marks(await anon('GET', '/api/events')), ['ok-1:00', 'ok-2:00']);
  assert.equal((await alice('GET', '/api/events/ok-1')).json.starred, true);
  assert.equal((await bob('GET', '/api/events/ok-1')).json.starred, false);
  assert.equal((await anon('GET', '/api/events/ok-1')).json.starred, false);
});

test('a state that is not a state is refused', async () => {
  for (const body of [{}, { starred: 'yes' }, { hidden: 1 }, { starred: true, hidden: null }, { starred: [true] }]) {
    assert.equal((await alice('PUT', '/api/events/ok-1/state', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await alice('PUT', '/api/events/ok-1/state')).status, 400, 'no body at all');
  assert.equal((await alice('PUT', `/api/events/${'g'.repeat(101)}/state`, { starred: true })).status, 400, 'a group is not that long');
  // An event that is not on the list is not given a row, however well formed the request.
  for (const gone of ['cull-1', 'hide-1', 'made-up']) assert.equal((await alice('PUT', `/api/events/${gone}/state`, { starred: true })).status, 404, gone);
  assert.deepEqual((await alice('GET', '/api/events')).json.map((e: { group: string }) => e.group), ['ok-1', 'ok-2']);
});

