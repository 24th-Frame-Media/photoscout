import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type Client } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
const { db } = await import('../src/db.js');
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

let n = 1000;
/** A new person, signed in, for a test that counts things or hits a daily cap. */
async function person(name: string): Promise<Client> {
  const c = app.client();
  await app.signIn(c, 'google', { id: String(++n), name });
  return c;
}
const idOf = async (c: Client): Promise<string> => (await c('GET', '/api/auth/status')).json.user.id;
const feedOf = async (c: Client, qs = ''): Promise<any[]> => (await c('GET', `/api/feed${qs}`)).json;
const checkin = (c: Client, extra: Record<string, unknown> = {}) =>
  c('POST', '/api/checkins', { lat: -33.4, lng: 149.6, placeName: 'Lookout', ...extra });
const DAY = 86_400_000;
const meet = (extra: Record<string, unknown> = {}) => ({
  title: 'Cars and coffee', description: '', startTime: new Date(Date.now() + 5 * DAY).toISOString(), endTime: null,
  venueName: 'Showground', address: '', lat: -33.42, lng: 149.58, priceText: '', visibility: 'public', ...extra,
});

test('a visitor reads the feed and comments; every write, and the following scope, needs a session', async () => {
  const post = (await checkin(alice, { body: 'Dawn run' })).json;
  const r = await anon('GET', '/api/feed');
  assert.equal(r.status, 200);
  assert.ok(r.json.some((p: { id: string }) => p.id === post.id));
  assert.equal((await anon('GET', `/api/posts/${post.id}/comments`)).status, 200);
  assert.equal((await anon('GET', '/api/feed?scope=following')).status, 401);
  assert.equal((await anon('GET', '/api/feed?scope=nonsense')).status, 400);
  assert.equal((await anon('GET', '/api/feed?before=yesterday')).status, 400);
  for (const [method, url, body] of [
    ['POST', '/api/checkins', { lat: 1, lng: 1, placeName: 'x' }], ['DELETE', `/api/posts/${post.id}`], ['PUT', `/api/posts/${post.id}/vote`],
    ['DELETE', `/api/posts/${post.id}/vote`], ['POST', `/api/posts/${post.id}/comments`, { body: 'hi' }], ['DELETE', '/api/comments/x'],
  ] as [string, string, unknown?][]) {
    assert.equal((await anon(method, url, body)).status, 401, `${method} ${url}`);
  }
});

test('a check-in has exactly the listed fields and links to the map', async () => {
  const r = await checkin(alice, { body: 'Great light', placeName: 'Hassans Walls' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json).sort(), ['author', 'body', 'comments', 'created_at', 'id', 'kind', 'lat', 'link', 'lng', 'place_name', 'votes', 'voted'].sort());
  assert.deepEqual(Object.keys(r.json.author).sort(), ['avatar', 'username']);
  assert.equal(r.json.kind, 'checkin');
  assert.equal(r.json.author.username, 'Alice');
  assert.equal(r.json.link, '/?lat=-33.4&lng=149.6');
  assert.equal(r.json.votes, 0);
});

test('check-in input is checked, and a spot or event must be a public one', async () => {
  const bad = async (patch: Record<string, unknown>, why: string) => assert.equal((await checkin(alice, patch)).status, 400, why);
  await bad({ placeName: 'x'.repeat(121) }, 'place name too long');
  await bad({ placeName: '' }, 'no place name');
  await bad({ placeName: undefined }, 'no place name at all');
  await bad({ body: 'x'.repeat(501) }, 'body too long');
  await bad({ body: 7 }, 'body not text');
  await bad({ lat: 91 }, 'lat out of range');
  await bad({ lng: undefined }, 'no lng');
  await bad({ spotId: 'a', eventId: 'b' }, 'both');
  assert.equal((await alice('POST', '/api/checkins', [])).status, 400);
  assert.equal((await checkin(alice, { placeName: 'x'.repeat(120), body: 'x'.repeat(500) })).status, 201, 'the edges');

  const mk = async (visibility: string) => (await alice('POST', '/api/spots', { name: `Spot ${visibility}`, lat: -33.1, lng: 149.1, visibility })).json.id;
  const pub = await alice('POST', '/api/checkins', { spotId: await mk('public') });
  assert.equal(pub.status, 201);
  assert.equal(pub.json.place_name, 'Spot public');
  assert.equal(pub.json.lat, -33.1);
  assert.equal((await alice('POST', '/api/checkins', { spotId: await mk('private') })).status, 404, 'private spot');
  assert.equal((await alice('POST', '/api/checkins', { spotId: 'nope' })).status, 404);

  const ev = (await alice('POST', '/api/community-events', meet())).json.id;
  const at = await bob('POST', '/api/checkins', { eventId: ev, body: 'Here' });
  assert.equal(at.status, 201);
  assert.equal(at.json.place_name, 'Cars and coffee');
  const unlisted = (await alice('POST', '/api/community-events', meet({ visibility: 'unlisted' }))).json.id;
  assert.equal((await bob('POST', '/api/checkins', { eventId: unlisted })).status, 404, 'unlisted event');
});

test('votes are one per person and personal; comments are listed, counted and size-limited', async () => {
  const post = (await checkin(alice)).json;
  const first = await bob('PUT', `/api/posts/${post.id}/vote`);
  assert.deepEqual(first.json, { votes: 1, voted: true });
  assert.equal((await bob('PUT', `/api/posts/${post.id}/vote`)).json.votes, 1, 'twice is one');
  assert.equal((await alice('PUT', `/api/posts/${post.id}/vote`)).json.votes, 2);
  assert.equal((await feedOf(bob)).find((p) => p.id === post.id).voted, true);
  assert.equal((await feedOf(anon)).find((p) => p.id === post.id).voted, false);
  assert.deepEqual((await bob('DELETE', `/api/posts/${post.id}/vote`)).json, { votes: 1, voted: false });
  assert.equal((await bob('PUT', '/api/posts/nope/vote')).status, 404);

  const c = await bob('POST', `/api/posts/${post.id}/comments`, { body: 'Nice one' });
  assert.equal(c.status, 201);
  assert.deepEqual(Object.keys(c.json).sort(), ['author', 'body', 'created_at', 'id']);
  assert.equal((await feedOf(anon)).find((p) => p.id === post.id).comments, 1);
  const list = (await anon('GET', `/api/posts/${post.id}/comments`)).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].author.username, 'Bobby');
  assert.equal((await bob('POST', `/api/posts/${post.id}/comments`, { body: 'x'.repeat(501) })).status, 400);
  assert.equal((await bob('POST', `/api/posts/${post.id}/comments`, { body: '   ' })).status, 400);
  assert.equal((await bob('POST', `/api/posts/${post.id}/comments`, { body: 'x'.repeat(500) })).status, 201);
  assert.equal((await bob('POST', '/api/posts/nope/comments', { body: 'hi' })).status, 404);
  assert.equal((await anon('GET', '/api/posts/nope/comments')).status, 404);
});

test('only the author or staff may delete a post or a comment', async () => {
  const post = (await checkin(alice)).json;
  const comment = (await alice('POST', `/api/posts/${post.id}/comments`, { body: 'mine' })).json;
  assert.equal((await bob('DELETE', `/api/posts/${post.id}`)).status, 403);
  assert.equal((await bob('DELETE', `/api/comments/${comment.id}`)).status, 403);
  assert.equal((await bob('DELETE', '/api/posts/nope')).status, 404);
  assert.equal((await alice('DELETE', `/api/comments/${comment.id}`)).status, 200);
  assert.equal((await alice('DELETE', `/api/posts/${post.id}`)).status, 200);
  assert.equal((await feedOf(anon)).some((p) => p.id === post.id), false);
  const again = (await checkin(alice)).json;
  assert.equal((await admin('DELETE', `/api/posts/${again.id}`)).status, 200, 'an admin may');
});

test('the following scope shows only people you follow', async () => {
  const carol = await person('Carol');
  const dan = await person('Dan');
  await carol('PUT', '/api/follows/Dan');
  const mine = (await dan('POST', '/api/checkins', { lat: 1, lng: 1, placeName: 'Dans place' })).json;
  const other = (await alice('POST', '/api/checkins', { lat: 1, lng: 1, placeName: 'Alices place' })).json;
  const ids = (await feedOf(carol, '?scope=following')).map((p) => p.id);
  assert.ok(ids.includes(mine.id));
  assert.equal(ids.includes(other.id), false);
  assert.equal((await feedOf(dan, '?scope=following')).length, 0, 'follows nobody');
});

test('a suspended account\'s posts and comments are out of every read, and come back with it', async () => {
  const erin = await person('Erin');
  const erinId = await idOf(erin);
  const alicePost = (await checkin(alice)).json;
  const post = (await checkin(erin)).json;
  await erin('POST', `/api/posts/${alicePost.id}/comments`, { body: 'from erin' });
  await admin('PATCH', `/api/users/${erinId}`, { banned: true });
  assert.equal((await feedOf(anon)).some((p) => p.id === post.id), false);
  assert.equal((await anon('GET', `/api/posts/${alicePost.id}/comments`)).json.length, 0);
  assert.equal((await feedOf(anon)).find((p) => p.id === alicePost.id).comments, 0);
  assert.equal((await bob('PUT', `/api/posts/${post.id}/vote`)).status, 404);
  await admin('PATCH', `/api/users/${erinId}`, { banned: false });
  assert.equal((await feedOf(anon)).some((p) => p.id === post.id), true);
});

test('a ride, gear, an RSVP and a public event post themselves; an unlisted event does not; deleting removes them', async () => {
  const frank = await person('Frank');
  const find = async (kind: string, body: string) => (await feedOf(anon)).find((p) => p.kind === kind && p.body === body);

  const ride = (await frank('POST', '/api/kit/rides', { kind: 'car', make: 'Mazda', model: 'MX-5', year: 2019 })).json;
  const ridePost = await find('ride', '2019 Mazda MX-5');
  assert.ok(ridePost);
  assert.equal(ridePost.author.username, 'Frank');
  assert.equal(ridePost.link, '/u/Frank');
  await frank('DELETE', `/api/kit/rides/${ride.id}`);
  assert.equal(await find('ride', '2019 Mazda MX-5'), undefined, 'the ride is gone and so is its post');

  const gear = (await frank('POST', '/api/kit/gear', { kind: 'lens', brand: 'Sigma', name: '35mm f1.4' })).json;
  assert.ok(await find('gear', 'Sigma 35mm f1.4'));
  await frank('DELETE', `/api/kit/gear/${gear.id}`);
  assert.equal(await find('gear', 'Sigma 35mm f1.4'), undefined);

  const open = (await frank('POST', '/api/community-events', meet({ title: 'Open meet' }))).json;
  const eventPost = await find('event', 'Open meet');
  assert.ok(eventPost);
  assert.equal(eventPost.link, `/events?open=${open.id}`);
  await bob('PUT', `/api/community-events/${open.id}/rsvp`);
  await bob('PUT', `/api/community-events/${open.id}/rsvp`);
  assert.equal((await feedOf(anon)).filter((p) => p.kind === 'rsvp' && p.body === 'Open meet').length, 1, 'twice is one post');
  await bob('DELETE', `/api/community-events/${open.id}/rsvp`);
  assert.equal(await find('rsvp', 'Open meet'), undefined, 'leaving takes the post with it');
  await alice('PUT', `/api/community-events/${open.id}/rsvp`);
  await frank('DELETE', `/api/community-events/${open.id}`);
  assert.equal(await find('event', 'Open meet'), undefined);
  assert.equal(await find('rsvp', 'Open meet'), undefined, 'the event is gone, and its RSVP posts');

  const secret = (await frank('POST', '/api/community-events', meet({ title: 'Secret meet', visibility: 'unlisted' }))).json;
  await bob('PUT', `/api/community-events/${secret.id}/rsvp`);
  assert.equal(await find('event', 'Secret meet'), undefined, 'unlisted never posts');
  assert.equal(await find('rsvp', 'Secret meet'), undefined);
  const turned = (await frank('POST', '/api/community-events', meet({ title: 'Turned meet' }))).json;
  await frank('PATCH', `/api/community-events/${turned.id}`, { visibility: 'unlisted' });
  assert.equal(await find('event', 'Turned meet'), undefined, 'made unlisted, its post goes');
});

test('feed pages are 30 long and `before` continues from the oldest', async () => {
  const grace = await person('Grace');
  for (let i = 0; i < 30; i++) assert.equal((await checkin(grace, { body: `run ${i}` })).status, 201);
  const page = await feedOf(anon);
  assert.equal(page.length, 30);
  const oldest = page[page.length - 1].created_at;
  const next = await feedOf(anon, `?before=${encodeURIComponent(oldest)}`);
  assert.ok(next.length > 0);
  assert.ok(next.every((p) => p.created_at < oldest));
  assert.equal(next.some((p) => page.some((q) => q.id === p.id)), false);
  // The thirty-first check-in of the day is refused.
  const over = await checkin(grace);
  assert.equal(over.status, 429);
  assert.match(over.json.error, /30/);
  assert.equal((await checkin(alice)).status, 201, 'per person');
});

test('at most 200 comments a day per person', async () => {
  const heidi = await person('Heidi');
  const post = (await checkin(alice)).json;
  for (let i = 0; i < 200; i++) assert.equal((await heidi('POST', `/api/posts/${post.id}/comments`, { body: `c${i}` })).status, 201);
  const over = await heidi('POST', `/api/posts/${post.id}/comments`, { body: 'one more' });
  assert.equal(over.status, 429);
  assert.equal((await bob('POST', `/api/posts/${post.id}/comments`, { body: 'fine' })).status, 201);
});

test('deleting a user removes their posts, votes, comments, chat and reports, and the votes and comments on their posts', async () => {
  const ivan = await person('Ivan');
  const ivanId = await idOf(ivan);
  const count = (sql: string) => Number((db.handle.prepare(sql).get(ivanId) as { n: number | bigint }).n);
  const aPost = (await checkin(alice)).json;
  const mine = (await checkin(ivan)).json;
  await ivan('PUT', `/api/posts/${aPost.id}/vote`);
  await ivan('POST', `/api/posts/${aPost.id}/comments`, { body: 'from ivan' });
  await bob('PUT', `/api/posts/${mine.id}/vote`);
  await bob('POST', `/api/posts/${mine.id}/comments`, { body: 'to ivan' });
  await ivan('POST', '/api/chat', { body: 'hello' });
  await ivan('POST', '/api/reports', { targetKind: 'post', targetId: aPost.id, reason: 'x' });
  await ivan('POST', '/api/kit/rides', { kind: 'car', make: 'Honda', model: 'S2000' });
  assert.equal((await admin('DELETE', `/api/users/${ivanId}`)).status, 200);
  for (const sql of [
    'SELECT COUNT(*) AS n FROM posts WHERE owner_id = ?', 'SELECT COUNT(*) AS n FROM post_votes WHERE user_id = ?',
    'SELECT COUNT(*) AS n FROM post_comments WHERE owner_id = ?', 'SELECT COUNT(*) AS n FROM chat_messages WHERE owner_id = ?',
    'SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?',
  ]) assert.equal(count(sql), 0, sql);
  assert.equal(Number((db.handle.prepare('SELECT COUNT(*) AS n FROM post_votes WHERE post_id = ?').get(mine.id) as { n: number | bigint }).n), 0);
  assert.equal(Number((db.handle.prepare('SELECT COUNT(*) AS n FROM post_comments WHERE post_id = ?').get(mine.id) as { n: number | bigint }).n), 0);
  assert.equal((await feedOf(anon)).some((p) => p.author.username === 'Ivan'), false);
});
