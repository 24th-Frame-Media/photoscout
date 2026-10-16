import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
const { eventSource, forgetEventList } = await import('../src/events.js');
after(() => app.close());

/** What event-scout has on show. `show` changes it and drops the kept list, so the change is read at once. */
const upstream = (group: string) => ({ group, title: `Event ${group}`, startTime: '2030-01-05T09:00:00.000Z', venueName: 'The Venue', lat: -33.4, lng: 149.5 });
let feed: string[] = [];
eventSource.read = () => feed.map(upstream);
function show(...groups: string[]): void {
  feed = groups;
  forgetEventList();
}
show('ok-1', 'ok-2', 'ok-3', 'ok-4', 'big');

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const meet = () => ({
  title: 'Cars and coffee', description: '', startTime: inDays(5), venueName: 'Bathurst Showground', address: 'Kendall Ave',
  lat: -33.42, lng: 149.58, priceText: 'Free', visibility: 'public',
});

const anon = app.client();
const alice = app.client();
const bob = app.client();
const carol = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
const idOf = async (c: typeof alice) => (await c('GET', '/api/auth/status')).json.user.id as string;
const aliceId = await idOf(alice);
const bobId = await idOf(bob);
const carolId = await idOf(carol);

test('going or interested: one answer each, changed or cleared, with the counts and the caller\'s own', async () => {
  const put = await alice('PUT', '/api/events/ok-1/rsvp', { status: 'going' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { rsvp: { going: 1, interested: 0, mine: 'going', attendees: [{ id: aliceId, username: 'Alice', avatar: '' }] } });
  assert.deepEqual((await bob('PUT', '/api/events/ok-1/rsvp', { status: 'interested' })).json.rsvp, {
    going: 1, interested: 1, mine: 'interested', attendees: [{ id: aliceId, username: 'Alice', avatar: '' }],
  });
  // Changing one's mind moves the answer, and the names on it follow.
  assert.deepEqual((await alice('PUT', '/api/events/ok-1/rsvp', { status: 'interested' })).json.rsvp, { going: 0, interested: 2, mine: 'interested', attendees: [] });
  assert.equal((await alice('PUT', '/api/events/ok-1/rsvp', { status: 'interested' })).json.rsvp.interested, 2, 'twice is one');
  assert.deepEqual((await bob('DELETE', '/api/events/ok-1/rsvp')).json.rsvp, { going: 0, interested: 1, mine: null, attendees: [] });
  assert.deepEqual((await alice('DELETE', '/api/events/ok-1/rsvp')).json.rsvp, { going: 0, interested: 0, mine: null, attendees: [] });
  assert.equal((await alice('DELETE', '/api/events/ok-1/rsvp')).status, 200, 'clearing twice is fine');
});

test('a status that is not going or interested is refused, and a visitor cannot answer', async () => {
  for (const body of [undefined, {}, { status: 'maybe' }, { status: 'Going' }, { status: ['going'] }, { status: null }]) {
    assert.equal((await alice('PUT', '/api/events/ok-1/rsvp', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await anon('PUT', '/api/events/ok-1/rsvp', { status: 'going' })).status, 401);
  assert.equal((await anon('DELETE', '/api/events/ok-1/rsvp')).status, 401);
  assert.equal((await anon('GET', '/api/events/ok-1/rsvp')).status, 200, 'reading is public');
});

test('an event that has left the list takes no answers, but a stale answer can still be cleared', async () => {
  assert.equal((await alice('PUT', '/api/events/nothing-like-it/rsvp', { status: 'going' })).status, 404);
  assert.equal((await anon('GET', '/api/events/nothing-like-it/rsvp')).status, 404);
  assert.equal((await alice('PUT', '/api/events/ok-4/rsvp', { status: 'going' })).status, 200);
  show('ok-1', 'ok-2', 'ok-3', 'big');
  assert.equal((await alice('GET', '/api/events/ok-4')).status, 404);
  assert.equal((await alice('PUT', '/api/events/ok-4/rsvp', { status: 'going' })).status, 404);
  assert.equal((await alice('GET', '/api/events/ok-4/rsvp')).status, 404);
  assert.deepEqual((await alice('DELETE', '/api/events/ok-4/rsvp')).json.rsvp, { going: 0, interested: 0, mine: null, attendees: [] });
  show('ok-1', 'ok-2', 'ok-3', 'ok-4', 'big');
  assert.equal((await alice('GET', '/api/events/ok-4/rsvp')).json.rsvp.going, 0);
});

test('the list and one event carry the counts and the caller\'s own answer', async () => {
  await alice('PUT', '/api/events/ok-2/rsvp', { status: 'going' });
  await bob('PUT', '/api/events/ok-2/rsvp', { status: 'going' });
  await bob('PUT', '/api/events/ok-3/rsvp', { status: 'interested' });
  type Row = { group: string; going: number; interested: number; myRsvp: string | null };
  const marks = (rows: Row[]) => rows.filter((e) => e.group === 'ok-2' || e.group === 'ok-3').map((e) => [e.group, e.going, e.interested, e.myRsvp]);
  assert.deepEqual(marks((await alice('GET', '/api/events')).json), [['ok-2', 2, 0, 'going'], ['ok-3', 0, 1, null]]);
  assert.deepEqual(marks((await bob('GET', '/api/events')).json), [['ok-2', 2, 0, 'going'], ['ok-3', 0, 1, 'interested']]);
  assert.deepEqual(marks((await anon('GET', '/api/events')).json), [['ok-2', 2, 0, null], ['ok-3', 0, 1, null]]);
  const one = (await anon('GET', '/api/events/ok-2')).json;
  assert.deepEqual([one.going, one.interested, one.myRsvp], [2, 0, null]);
  assert.equal((await bob('GET', '/api/events/ok-2')).json.myRsvp, 'going');
  // A visitor is told the counts, not who is behind them; someone signed in is told the names.
  assert.deepEqual((await anon('GET', '/api/events/ok-2/rsvp')).json.rsvp, { going: 2, interested: 0, mine: null, attendees: [] });
  const named = (await bob('GET', '/api/events/ok-2/rsvp')).json.rsvp;
  assert.deepEqual([named.going, named.interested, named.mine], [2, 0, 'going']);
  assert.deepEqual(named.attendees.map((a: { username: string }) => a.username).sort(), ['Alice', 'Bobby']);
});

test('a banned account is left out of the counts and the names, and comes back with them', async () => {
  await carol('PUT', '/api/events/ok-1/rsvp', { status: 'going' });
  await alice('PUT', '/api/events/ok-1/rsvp', { status: 'interested' });
  const community = (await alice('POST', '/api/community-events', meet())).json.id;
  await carol('PUT', `/api/community-events/${community}/rsvp`);
  assert.equal((await anon('GET', '/api/events/ok-1/rsvp')).json.rsvp.going, 1);
  assert.deepEqual((await bob('GET', '/api/events/ok-1/rsvp')).json.rsvp.attendees.map((a: { username: string }) => a.username), ['Carol']);
  assert.deepEqual((await bob('GET', `/api/community-events/${community}/rsvp`)).json.rsvp.attendees.map((a: { username: string }) => a.username), ['Carol']);

  await admin('PATCH', `/api/users/${carolId}`, { banned: true });
  assert.deepEqual((await bob('GET', '/api/events/ok-1/rsvp')).json.rsvp, { going: 0, interested: 1, mine: null, attendees: [] });
  assert.equal((await anon('GET', '/api/events')).json.find((e: { group: string }) => e.group === 'ok-1').going, 0);
  assert.deepEqual((await bob('GET', `/api/community-events/${community}/rsvp`)).json.rsvp, { going: 0, interested: 0, mine: null, attendees: [] });
  assert.equal((await anon('GET', `/api/community-events/${community}`)).json.going, 0);

  await admin('PATCH', `/api/users/${carolId}`, { banned: false });
  assert.equal((await anon('GET', '/api/events/ok-1/rsvp')).json.rsvp.going, 1);
  assert.equal((await anon('GET', `/api/community-events/${community}/rsvp`)).json.rsvp.going, 1);
});

test('the names are the first twelve going, and the count is all of them', async () => {
  for (let i = 0; i < 13; i++) {
    const c = app.client();
    await app.signIn(c, 'google', { id: `crowd-${i}`, name: `Crowd${i}` });
    assert.equal((await c('PUT', '/api/events/big/rsvp', { status: 'going' })).status, 200);
  }
  const r = (await bob('GET', '/api/events/big/rsvp')).json.rsvp;
  assert.equal(r.going, 13);
  assert.equal(r.attendees.length, 12);
});

test('a community event answers in the same shape, with no interested', async () => {
  const id = (await alice('POST', '/api/community-events', meet())).json.id;
  const attendee = [{ id: bobId, username: 'Bobby', avatar: '' }];
  assert.deepEqual((await bob('PUT', `/api/community-events/${id}/rsvp`)).json, { rsvp: { going: 1, interested: 0, mine: 'going', attendees: attendee } });
  assert.deepEqual((await anon('GET', `/api/community-events/${id}/rsvp`)).json.rsvp, { going: 1, interested: 0, mine: null, attendees: [] });
  assert.deepEqual((await bob('GET', `/api/community-events/${id}/rsvp`)).json.rsvp, { going: 1, interested: 0, mine: 'going', attendees: attendee });
  assert.deepEqual((await bob('DELETE', `/api/community-events/${id}/rsvp`)).json.rsvp, { going: 0, interested: 0, mine: null, attendees: [] });
  assert.equal((await anon('GET', '/api/community-events/nope/rsvp')).status, 404);
});
