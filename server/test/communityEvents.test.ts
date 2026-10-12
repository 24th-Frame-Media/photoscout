import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const meet = () => ({
  title: 'Cars and coffee', description: 'Bring a camera', startTime: inDays(5), endTime: inDays(5.1),
  venueName: 'Bathurst Showground', address: 'Kendall Ave', lat: -33.42, lng: 149.58, priceText: 'Free', visibility: 'public',
});

test('create, read anonymously, edit, delete', async () => {
  const made = await alice('POST', '/api/community-events', meet());
  assert.equal(made.status, 201);
  assert.equal(made.json.title, 'Cars and coffee');
  assert.equal(made.json.going, 0);
  assert.equal(made.json.isGoing, false);
  assert.equal(made.json.owner.username, 'Alice');
  assert.deepEqual(Object.keys(made.json.owner).sort(), ['avatar', 'username']);

  const one = await anon('GET', `/api/community-events/${made.json.id}`);
  assert.equal(one.status, 200);
  assert.ok((await anon('GET', '/api/community-events')).json.some((e: { id: string }) => e.id === made.json.id));

  const edited = await alice('PATCH', `/api/community-events/${made.json.id}`, { title: 'Cars, coffee and pies', priceText: '' });
  assert.equal(edited.json.title, 'Cars, coffee and pies');
  assert.equal(edited.json.venueName, 'Bathurst Showground', 'fields left out are kept');
  assert.equal((await alice('PATCH', `/api/community-events/${made.json.id}`, { endTime: null })).json.endTime, null);

  assert.equal((await alice('DELETE', `/api/community-events/${made.json.id}`)).status, 200);
  assert.equal((await anon('GET', `/api/community-events/${made.json.id}`)).status, 404);
});

test('every field is checked', async () => {
  const bad = async (patch: Record<string, unknown>, why: string) => {
    const r = await alice('POST', '/api/community-events', { ...meet(), ...patch });
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.json)}`);
  };
  await bad({ title: '' }, 'no title');
  await bad({ title: 'x'.repeat(151) }, 'title too long');
  await bad({ description: 'x'.repeat(4001) }, 'description too long');
  await bad({ venueName: 'x'.repeat(151) }, 'venue too long');
  await bad({ address: 'x'.repeat(301) }, 'address too long');
  await bad({ priceText: 'x'.repeat(61) }, 'price too long');
  await bad({ title: 7 }, 'title not text');
  await bad({ startTime: undefined }, 'no start');
  await bad({ startTime: 'next tuesday' }, 'not a date');
  await bad({ startTime: '2030-01-01' }, 'no time');
  await bad({ startTime: inDays(5).replace('Z', '') }, 'no zone');
  await bad({ startTime: 12345 }, 'a number');
  await bad({ startTime: inDays(-1), endTime: null }, 'in the past');
  await bad({ startTime: inDays(401), endTime: null }, 'too far ahead');
  await bad({ endTime: inDays(4) }, 'ends before it starts');
  await bad({ endTime: meet().startTime }, 'ends as it starts');
  await bad({ startTime: inDays(5), endTime: inDays(20) }, 'longer than 14 days');
  await bad({ lat: undefined }, 'no lat');
  await bad({ lat: 91 }, 'lat out of range');
  await bad({ lng: -181 }, 'lng out of range');
  await bad({ lat: '10' }, 'lat as text');
  await bad({ lat: null }, 'lat null');
  await bad({ visibility: 'private' }, 'private is not a choice');
  await bad({ visibility: 'secret' }, 'unknown visibility');
  assert.equal((await alice('POST', '/api/community-events', [meet()])).status, 400);
  assert.equal((await alice('POST', '/api/community-events', { ...meet(), startTime: inDays(399), endTime: inDays(399 + 14) })).status, 201, 'the edges');
  assert.equal((await alice('POST', '/api/community-events', { ...meet(), endTime: undefined, visibility: undefined })).status, 201, 'end and visibility are optional');
});

test('an edit is held to the same rules as a new event', async () => {
  const id = (await alice('POST', '/api/community-events', meet())).json.id;
  const bad = async (patch: Record<string, unknown>) => assert.equal((await alice('PATCH', `/api/community-events/${id}`, patch)).status, 400, JSON.stringify(patch));
  await bad({ startTime: inDays(-2) });
  await bad({ startTime: inDays(500) });
  await bad({ lat: 200 });
  await bad({ visibility: 'private' });
  await bad({ endTime: inDays(1) });
  await bad({ title: '' });
  assert.equal((await alice('PATCH', `/api/community-events/${id}`, { startTime: inDays(8), endTime: inDays(8.2) })).status, 200);
  assert.equal((await alice('PATCH', `/api/community-events/${id}`, { startTime: inDays(9) })).status, 400, 'moving the start past the end');
});

test('only the organiser or an admin may change an event', async () => {
  const id = (await alice('POST', '/api/community-events', meet())).json.id;
  assert.equal((await anon('POST', '/api/community-events', meet())).status, 401);
  assert.equal((await anon('PATCH', `/api/community-events/${id}`, { title: 'x' })).status, 401);
  assert.equal((await anon('DELETE', `/api/community-events/${id}`)).status, 401);
  assert.equal((await bob('PATCH', `/api/community-events/${id}`, { title: 'Hacked' })).status, 403);
  assert.equal((await bob('DELETE', `/api/community-events/${id}`)).status, 403);
  assert.equal((await bob('PATCH', '/api/community-events/nope', { title: 'x' })).status, 404);
  assert.equal((await anon('GET', `/api/community-events/${id}`)).json.title, 'Cars and coffee');
  assert.equal((await admin('PATCH', `/api/community-events/${id}`, { title: 'Moderated' })).json.title, 'Moderated');
  assert.equal((await admin('DELETE', `/api/community-events/${id}`)).status, 200);
});

test('unlisted events are not in anyone else\'s list but can be opened by id', async () => {
  const id = (await alice('POST', '/api/community-events', { ...meet(), visibility: 'unlisted' })).json.id;
  const ids = async (c: typeof alice) => (await c('GET', '/api/community-events')).json.map((e: { id: string }) => e.id);
  assert.equal((await ids(anon)).includes(id), false);
  assert.equal((await ids(bob)).includes(id), false);
  assert.equal((await ids(alice)).includes(id), true, 'the organiser sees it');
  assert.equal((await anon('GET', `/api/community-events/${id}`)).status, 200);
  assert.equal((await alice('PATCH', `/api/community-events/${id}`, { visibility: 'public' })).json.visibility, 'public');
  assert.equal((await ids(bob)).includes(id), true);
});

test('RSVP: sign-in required, idempotent, counted, and personal', async () => {
  const id = (await alice('POST', '/api/community-events', meet())).json.id;
  assert.equal((await anon('PUT', `/api/community-events/${id}/rsvp`)).status, 401);
  assert.equal((await anon('DELETE', `/api/community-events/${id}/rsvp`)).status, 401);
  assert.equal((await bob('PUT', '/api/community-events/nope/rsvp')).status, 404);
  const first = await bob('PUT', `/api/community-events/${id}/rsvp`);
  assert.equal(first.json.going, 1);
  assert.equal(first.json.isGoing, true);
  assert.equal((await bob('PUT', `/api/community-events/${id}/rsvp`)).json.going, 1, 'twice is one');
  assert.equal((await alice('PUT', `/api/community-events/${id}/rsvp`)).json.going, 2);
  assert.equal((await anon('GET', `/api/community-events/${id}`)).json.going, 2);
  assert.equal((await anon('GET', `/api/community-events/${id}`)).json.isGoing, false);
  assert.equal((await bob('GET', `/api/community-events/${id}`)).json.isGoing, true);
  const listed = (await bob('GET', '/api/community-events')).json.find((e: { id: string }) => e.id === id);
  assert.equal(listed.isGoing, true);
  assert.equal((await bob('DELETE', `/api/community-events/${id}/rsvp`)).json.going, 1);
  assert.equal((await bob('DELETE', `/api/community-events/${id}/rsvp`)).json.isGoing, false, 'leaving twice is fine');
  assert.equal((await alice('DELETE', `/api/community-events/${id}`)).status, 200);
  assert.equal((await bob('PUT', `/api/community-events/${id}/rsvp`)).status, 404, 'the event is gone');
});

test('at most 20 upcoming events per person', async () => {
  const carol = app.client();
  await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
  for (let i = 0; i < 20; i++) assert.equal((await carol('POST', '/api/community-events', { ...meet(), title: `Meet ${i}` })).status, 201);
  const over = await carol('POST', '/api/community-events', meet());
  assert.equal(over.status, 409);
  assert.match(over.json.error, /20/);
  assert.equal((await alice('POST', '/api/community-events', meet())).status, 201, 'per person');
});

test('a suspended organiser\'s events drop out of sight, and come back with them', async () => {
  const dave = app.client();
  await app.signIn(dave, 'google', { id: '444', name: 'Dave' });
  const daveId = (await dave('GET', '/api/auth/status')).json.user.id;
  const id = (await dave('POST', '/api/community-events', meet())).json.id;
  await admin('PATCH', `/api/users/${daveId}`, { banned: true });
  assert.equal((await anon('GET', `/api/community-events/${id}`)).status, 404);
  assert.equal((await bob('PUT', `/api/community-events/${id}/rsvp`)).status, 404);
  assert.equal((await anon('GET', '/api/community-events')).json.some((e: { id: string }) => e.id === id), false);
  assert.equal((await admin('GET', `/api/community-events/${id}`)).status, 200, 'an admin can still see it');
  await admin('PATCH', `/api/users/${daveId}`, { banned: false });
  assert.equal((await anon('GET', `/api/community-events/${id}`)).status, 200);
});

test('the scraped feed is untouched: community events are not in /api/events', async () => {
  const r = await anon('GET', '/api/events');
  if (r.status === 200) assert.equal(JSON.stringify(r.json).includes('Cars and coffee'), false);
});
