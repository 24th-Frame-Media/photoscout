import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type Client } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
const mod = app.client();
const mod2 = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
await app.signIn(mod, 'google', { id: '701', name: 'Moddy' });
await app.signIn(mod2, 'google', { id: '702', name: 'Modette' });

const idOf = async (c: Client): Promise<string> => (await c('GET', '/api/auth/status')).json.user.id;
const [aliceId, bobId, adminId, modId, mod2Id] = await Promise.all([alice, bob, admin, mod, mod2].map(idOf));
assert.equal((await admin('PATCH', `/api/users/${modId}`, { role: 'moderator' })).json.role, 'moderator');
assert.equal((await admin('PATCH', `/api/users/${mod2Id}`, { role: 'moderator' })).json.role, 'moderator');

const DAY = 86_400_000;
const meet = (extra: Record<string, unknown> = {}) => ({
  title: 'Cars and coffee', description: 'Bring a camera', startTime: new Date(Date.now() + 5 * DAY).toISOString(), endTime: null,
  venueName: 'Showground', address: '', lat: -33.42, lng: 149.58, priceText: '', visibility: 'public', ...extra,
});
const checkin = async (c: Client, body = 'a check-in'): Promise<string> =>
  (await c('POST', '/api/checkins', { lat: -33.4, lng: 149.6, placeName: 'Lookout', body })).json.id;
const report = (c: Client, targetKind: string, targetId: string, reason = 'rude') => c('POST', '/api/reports', { targetKind, targetId, reason });
const queue = async (c: Client = mod): Promise<any[]> => (await c('GET', '/api/reports')).json;
const openFor = async (kind: string, id: string) => (await queue()).find((r) => r.target_kind === kind && r.target_id === id && !r.resolved_at);
const resolve = (c: Client, kind: string, id: string, action: string) =>
  openFor(kind, id).then((r) => c('POST', `/api/reports/${r.id}/resolve`, { action }));

test('only an admin can make a moderator; the role is checked', async () => {
  assert.equal((await alice('PATCH', `/api/users/${bobId}`, { role: 'moderator' })).status, 403);
  assert.equal((await admin('PATCH', `/api/users/${bobId}`, { role: 'janitor' })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${adminId}`, { role: 'moderator' })).status, 400, 'not your own');
});

test('a moderator has none of an admin\'s other powers', async () => {
  const spot = (await alice('POST', '/api/spots', { name: 'Alice spot', lat: -33, lng: 149, visibility: 'public' })).json.id;
  const secret = (await alice('POST', '/api/spots', { name: 'Alice secret', lat: -33, lng: 149, visibility: 'private' })).json.id;
  assert.equal((await mod('PATCH', `/api/users/${aliceId}`, { role: 'admin' })).status, 403, 'roles');
  assert.equal((await mod('PATCH', `/api/users/${aliceId}`, { role: 'moderator', banned: true })).status, 403, 'roles, even with a ban alongside');
  assert.equal((await mod('DELETE', `/api/users/${aliceId}`)).status, 403, 'deleting users');
  assert.equal((await mod('GET', '/api/users')).status, 403);
  assert.equal((await mod('PUT', '/api/settings', { tfnswApiKey: 'x' })).status, 403, 'settings');
  assert.equal((await mod('GET', '/api/tasks')).status, 403);
  assert.equal((await mod('POST', '/api/tasks/housekeeping/run')).status, 403);
  assert.equal((await mod('GET', '/api/remotes')).status, 403);
  assert.equal((await mod('PATCH', `/api/spots/${spot}`, { name: 'Mine now' })).status, 403, 'another person\'s spot');
  assert.equal((await mod('DELETE', `/api/spots/${secret}`)).status, 403, 'a private spot cannot be deleted');
  assert.equal((await mod('DELETE', `/api/spots/${spot}`)).status, 200, 'a public one can, to take abuse off the map');
  assert.equal((await mod('GET', `/api/spots/${secret}`)).status, 404, 'a private spot stays private');
  assert.equal((await mod('PATCH', `/api/users/${adminId}`, { banned: true })).status, 403, 'suspending an admin');
  assert.equal((await mod('PATCH', `/api/users/${mod2Id}`, { banned: true })).status, 403, 'suspending a moderator');
  assert.equal((await mod('PATCH', `/api/users/${modId}`, { banned: true })).status, 403, 'suspending themselves');
  assert.equal((await admin('GET', `/api/users`)).json.find((u: { id: string }) => u.id === adminId).banned, false);
  assert.equal((await mod2('GET', '/api/auth/status')).json.authed, true, 'and the other moderator still has a session');
});

test('a moderator can suspend and reinstate a contributor', async () => {
  const r = await mod('PATCH', `/api/users/${bobId}`, { banned: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.banned, true);
  assert.equal((await bob('GET', '/api/auth/status')).json.authed, false, 'their session ended');
  assert.equal((await mod('PATCH', `/api/users/${bobId}`, { banned: false })).json.banned, false);
  await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
  assert.equal((await bob('GET', '/api/auth/status')).json.authed, true);
});

test('reports: sign-in and staff are required; the input and the target are checked', async () => {
  const post = await checkin(alice);
  assert.equal((await anon('POST', '/api/reports', { targetKind: 'post', targetId: post })).status, 401);
  assert.equal((await anon('GET', '/api/reports')).status, 401);
  assert.equal((await bob('GET', '/api/reports')).status, 403, 'a contributor cannot read the queue');
  assert.equal((await bob('POST', '/api/reports/x/resolve', { action: 'hide' })).status, 403);
  assert.equal((await report(bob, 'nonsense', post)).status, 400);
  assert.equal((await report(bob, 'post', post, 'x'.repeat(301))).status, 400, 'reason too long');
  assert.equal((await report(bob, 'post', '')).status, 400);
  assert.equal((await bob('POST', '/api/reports', [])).status, 400);
  assert.equal((await report(bob, 'post', 'nope')).status, 404);
  const secret = (await alice('POST', '/api/spots', { name: 'Hidden spot', lat: -33, lng: 149, visibility: 'private' })).json.id;
  assert.equal((await report(bob, 'spot', secret)).status, 404, 'a private spot cannot be reported by a stranger');
  assert.equal((await report(bob, 'post', post, 'x'.repeat(300))).status, 201);
  const again = await report(bob, 'post', post);
  assert.equal(again.status, 409, 'one open report per target');
  assert.equal((await report(alice, 'post', post)).status, 201, 'another person may');
});

test('the queue shows a snapshot, the author and the reporter, open reports first', async () => {
  const post = await checkin(alice, 'This is the snapshot text');
  await report(bob, 'post', post, 'spam');
  const q = await queue();
  const row = q.find((r) => r.target_id === post);
  assert.deepEqual(Object.keys(row).sort(), ['author', 'created_at', 'id', 'reason', 'reporter', 'resolved_at', 'snapshot', 'target_id', 'target_kind']);
  assert.equal(row.snapshot, 'This is the snapshot text');
  assert.equal(row.reporter, 'Bobby');
  assert.equal(row.reason, 'spam');
  assert.deepEqual(row.author, { id: aliceId, username: 'Alice', role: 'contributor', banned: false });
  assert.equal((await queue(admin)).length, q.length, 'an admin reads the same queue');
  await resolve(mod, 'post', post, 'dismiss');
  const after = await queue();
  const firstSettled = after.findIndex((r) => r.resolved_at);
  assert.ok(firstSettled === -1 || after.slice(firstSettled).every((r) => r.resolved_at), 'open ones come first');
  assert.ok(firstSettled > -1, 'and the dismissed one is listed after them');
});

test('hiding a post or a comment takes it out of the feed', async () => {
  const post = await checkin(alice, 'to be hidden');
  const kept = await checkin(alice, 'to be kept');
  const comment = (await bob('POST', `/api/posts/${kept}/comments`, { body: 'bad words' })).json.id;
  await report(bob, 'post', post);
  await report(alice, 'post', post);
  await report(alice, 'comment', comment);
  await report(bob, 'post', kept);

  assert.equal((await resolve(bob, 'post', post, 'hide').catch(() => ({ status: 403 }))).status, 403, 'a contributor cannot resolve');
  assert.equal((await resolve(mod, 'post', post, 'hide')).status, 200);
  assert.equal((await anon('GET', '/api/feed')).json.some((p: { id: string }) => p.id === post), false);
  assert.equal((await alice('GET', '/api/feed')).json.some((p: { id: string }) => p.id === post), false, 'not even for its author');
  assert.equal((await anon('GET', `/api/posts/${post}/comments`)).status, 404);
  assert.equal((await openFor('post', post)), undefined, 'everyone\'s report on it was settled');
  assert.equal((await bob('PUT', `/api/posts/${post}/vote`)).status, 404);
  assert.equal((await report(bob, 'post', post)).status, 404, 'and it cannot be reported again');

  assert.equal((await resolve(admin, 'comment', comment, 'hide')).status, 200);
  assert.equal((await anon('GET', `/api/posts/${kept}/comments`)).json.length, 0);
  assert.equal((await anon('GET', '/api/feed')).json.find((p: { id: string }) => p.id === kept).comments, 0);

  assert.equal((await resolve(mod, 'post', kept, 'dismiss')).status, 200);
  assert.equal((await anon('GET', '/api/feed')).json.some((p: { id: string }) => p.id === kept), true, 'dismissing leaves it');
});

test('resolving needs a valid action and an open report', async () => {
  const post = await checkin(alice);
  await report(bob, 'post', post);
  const r = await openFor('post', post);
  assert.equal((await mod('POST', `/api/reports/${r.id}/resolve`, { action: 'burn' })).status, 400);
  assert.equal((await mod('POST', `/api/reports/${r.id}/resolve`, {})).status, 400);
  assert.equal((await mod('POST', '/api/reports/nope/resolve', { action: 'dismiss' })).status, 404);
  assert.equal((await mod('POST', `/api/reports/${r.id}/resolve`, { action: 'dismiss' })).status, 200);
  assert.equal((await mod('POST', `/api/reports/${r.id}/resolve`, { action: 'dismiss' })).status, 409);
  assert.equal((await report(bob, 'post', post)).status, 201, 'a settled report does not block a new one');
});

test('hiding chat deletes the message; a profile, ride or spot is only resolved', async () => {
  const msg = (await alice('POST', '/api/chat', { body: 'chat to remove' })).json.id;
  await report(bob, 'chat', msg);
  assert.equal((await resolve(mod, 'chat', msg, 'hide')).status, 200);
  assert.equal((await bob('GET', '/api/chat')).json.some((m: { id: string }) => m.id === msg), false);

  const ride = (await alice('POST', '/api/kit/rides', { kind: 'car', make: 'Datsun', model: '240Z' })).json.id;
  const spot = (await alice('POST', '/api/spots', { name: 'Reported spot', lat: -33, lng: 149, visibility: 'public' })).json.id;
  await report(bob, 'ride', ride);
  await report(bob, 'spot', spot);
  await report(bob, 'profile', aliceId);
  assert.equal((await openFor('ride', ride)).snapshot, 'Datsun 240Z');
  assert.equal((await openFor('spot', spot)).snapshot, 'Reported spot');
  assert.equal((await openFor('profile', aliceId)).author.username, 'Alice');
  for (const [kind, id] of [['ride', ride], ['spot', spot], ['profile', aliceId]]) assert.equal((await resolve(mod, kind, id, 'hide')).status, 200, kind);
  assert.equal((await anon('GET', `/api/spots/${spot}`)).status, 200, 'the spot is still there for an admin to deal with');
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.rides.some((r: { id: string }) => r.id === ride), true);
});

test('a hidden community event is gone for strangers and lists, and still opens for its organiser and staff', async () => {
  const ev = (await alice('POST', '/api/community-events', meet())).json.id;
  await bob('PUT', `/api/community-events/${ev}/rsvp`);
  await report(bob, 'community_event', ev);
  assert.match((await openFor('community_event', ev)).snapshot, /^Cars and coffee\. Bring a camera/);
  assert.equal((await anon('GET', `/api/community-events/${ev}`)).status, 200);
  assert.equal((await resolve(mod, 'community_event', ev, 'hide')).status, 200);
  assert.equal((await anon('GET', `/api/community-events/${ev}`)).status, 404);
  assert.equal((await bob('GET', `/api/community-events/${ev}`)).status, 404);
  assert.equal((await bob('PUT', `/api/community-events/${ev}/rsvp`)).status, 404);
  assert.equal((await alice('GET', `/api/community-events/${ev}`)).status, 200, 'its organiser');
  assert.equal((await mod('GET', `/api/community-events/${ev}`)).status, 200, 'staff');
  assert.equal((await admin('GET', `/api/community-events/${ev}`)).status, 200);
  for (const c of [anon, bob, alice, mod]) assert.equal((await c('GET', '/api/community-events')).json.some((e: { id: string }) => e.id === ev), false);
  const feedPosts = (await anon('GET', '/api/feed')).json.filter((p: { link: string }) => p.link === `/events?open=${ev}`);
  assert.equal(feedPosts.length, 0, 'its auto-posts are hidden with it');
  assert.equal((await alice('PATCH', `/api/community-events/${ev}`, { title: 'Still mine' })).status, 200);
});

test('a moderator can delete anyone\'s post, comment or chat message', async () => {
  const post = await checkin(alice);
  const comment = (await alice('POST', `/api/posts/${post}/comments`, { body: 'mine' })).json.id;
  const msg = (await alice('POST', '/api/chat', { body: 'mine too' })).json.id;
  assert.equal((await bob('DELETE', `/api/comments/${comment}`)).status, 403);
  assert.equal((await bob('DELETE', `/api/chat/${msg}`)).status, 403);
  assert.equal((await bob('DELETE', `/api/posts/${post}`)).status, 403);
  assert.equal((await mod('DELETE', `/api/comments/${comment}`)).status, 200);
  assert.equal((await mod('DELETE', `/api/chat/${msg}`)).status, 200);
  assert.equal((await mod('DELETE', `/api/posts/${post}`)).status, 200);
});

test('at most 20 reports a day per person', async () => {
  const author = app.client();
  const reporter = app.client();
  await app.signIn(author, 'google', { id: '801', name: 'Author' });
  await app.signIn(reporter, 'google', { id: '802', name: 'Reporter' });
  for (let i = 0; i < 21; i++) {
    const id = await checkin(author, `post ${i}`);
    const r = await report(reporter, 'post', id);
    assert.equal(r.status, i < 20 ? 201 : 429, `report ${i + 1}`);
    if (i === 20) assert.match(r.json.error, /20/);
  }
});
