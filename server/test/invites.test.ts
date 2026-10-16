import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
const { eventSource, forgetEventList } = await import('../src/events.js');
after(() => app.close());

/** What event-scout has on show. `show` changes it and drops the kept list, so the change is read at once. */
const upstream = (group: string) => ({ group, title: `Event ${group}`, startTime: '2030-01-05T09:00:00.000Z', venueName: 'The Venue', lat: -33.4, lng: 149.5 });
const RATE = Array.from({ length: 60 }, (_, i) => `rl-${i + 1}`);
let feed: string[] = [];
eventSource.read = () => feed.map(upstream);
function show(...groups: string[]): void {
  feed = groups;
  forgetEventList();
}
show('ok-1', 'ok-3', ...RATE);

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
const dave = app.client();
const erin = app.client();
const frank = app.client();
const gil = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
await app.signIn(dave, 'google', { id: '444', name: 'Dave' });
await app.signIn(erin, 'google', { id: '555', name: 'Erin' });
await app.signIn(frank, 'google', { id: '666', name: 'Frank' });
await app.signIn(gil, 'google', { id: '777', name: 'Gil' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
const idOf = async (c: typeof alice) => (await c('GET', '/api/auth/status')).json.user.id as string;
const aliceId = await idOf(alice);
const bobId = await idOf(bob);
const carolId = await idOf(carol);
const daveId = await idOf(dave);
const erinId = await idOf(erin);
const gilId = await idOf(gil);

// Recipients for the sends that would otherwise pile up on Bobby (five a person at most), and eleven senders for the list cap.
const POOL = ['Pool1', 'Pool2', 'Pool3', 'Pool4', 'Pool5', 'Pool6', 'Pool7'];
const pool: (typeof alice)[] = [];
for (const [i, name] of POOL.entries()) {
  const c = app.client();
  await app.signIn(c, 'google', { id: `pool-${i}`, name });
  pool.push(c);
}
const senders: (typeof alice)[] = [];
for (let s = 0; s < 11; s++) {
  const c = app.client();
  await app.signIn(c, 'google', { id: `sender-${s}`, name: `Sender${s}` });
  senders.push(c);
}

// Set by the first tests, and used by the later ones.
let eventInvite = '';
let communityInvite = '';
let communityId = '';
let poolInvite = '';   // Alice's first invite to Pool1
let senderInvite = ''; // Sender0's first invite to Bobby

test('an invite goes once, to someone who can be invited, about an event on the list', async () => {
  await admin('PATCH', `/api/users/${carolId}`, { banned: true });
  const sent = await alice('POST', '/api/invites', { kind: 'event', ref: 'ok-1', username: 'Bobby' });
  assert.equal(sent.status, 201);
  assert.deepEqual(Object.keys(sent.json.invite).sort(), ['createdAt', 'id', 'kind', 'ref', 'status', 'to']);
  assert.deepEqual(sent.json.invite.to, { id: bobId, username: 'Bobby', avatar: '' });
  assert.deepEqual([sent.json.invite.kind, sent.json.invite.ref, sent.json.invite.status], ['event', 'ok-1', 'pending']);
  eventInvite = sent.json.invite.id;
  const again = await alice('POST', '/api/invites', { kind: 'event', ref: 'ok-1', username: 'bobby' });
  assert.equal(again.status, 201);
  assert.equal(again.json.invite.id, eventInvite, 'the same invite, whatever the case of the name');

  communityId = (await alice('POST', '/api/community-events', meet())).json.id;
  const community = await alice('POST', '/api/invites', { kind: 'community', ref: communityId, username: 'Bobby' });
  assert.equal(community.status, 201);
  communityInvite = community.json.invite.id;

  const bad = async (body: unknown, status: number, why: string) => assert.equal((await alice('POST', '/api/invites', body)).status, status, why);
  await bad({ kind: 'event', ref: 'ok-1', username: 'Alice' }, 400, 'yourself');
  await bad({ kind: 'event', ref: 'ok-1', username: 'Nobody' }, 404, 'no such user');
  await bad({ kind: 'event', ref: 'ok-1', username: 'Bob by' }, 404, 'not a handle');
  await bad({ kind: 'event', ref: 'ok-1', username: 'Carol' }, 404, 'a banned user');
  await bad({ kind: 'event', ref: 'nothing-like-it', username: 'Bobby' }, 404, 'no such event');
  await bad({ kind: 'community', ref: 'nothing-like-it', username: 'Bobby' }, 404, 'no such community event');
  await bad({ kind: 'friends', ref: 'ok-1', username: 'Bobby' }, 400, 'an unknown kind');
  await bad({ kind: 'event', ref: 7, username: 'Bobby' }, 400, 'a ref that is not text');
  await bad({ kind: 'event', ref: 'ok-1' }, 400, 'no one to invite');
  await bad({ kind: 'event', ref: 'ok-1', username: 7 }, 400, 'a username that is not text');
  assert.equal((await anon('POST', '/api/invites', { kind: 'event', ref: 'ok-1', username: 'Bobby' })).status, 401);
});

test('a community event is invited to only by someone who can see it', async () => {
  const daveEvent = (await dave('POST', '/api/community-events', meet())).json.id;
  await admin('PATCH', `/api/users/${daveId}`, { banned: true });
  assert.equal((await alice('POST', '/api/invites', { kind: 'community', ref: daveEvent, username: 'Bobby' })).status, 404, 'the organiser is suspended');
  assert.equal((await admin('GET', `/api/community-events/${daveEvent}`)).status, 200, 'an admin still sees it');
});

test('the waiting invites come newest first, with a picture of each event, and only the recipient sees them', async () => {
  const mine = (await bob('GET', '/api/invites')).json;
  assert.deepEqual(mine.invites.map((i: { kind: string }) => i.kind), ['community', 'event']);
  assert.equal(mine.pendingCount, 2);
  const [community, event] = mine.invites;
  assert.deepEqual(Object.keys(community).sort(), ['createdAt', 'event', 'from', 'id', 'kind', 'ref']);
  assert.deepEqual(community.from, { id: aliceId, username: 'Alice', avatar: '' });
  assert.equal(community.event.title, 'Cars and coffee');
  assert.equal(community.event.venue, 'Bathurst Showground');
  assert.deepEqual(event.event, { title: 'Event ok-1', startsAt: '2030-01-05T09:00:00.000Z', venue: 'The Venue', imageUrl: '' });
  assert.deepEqual(await alice('GET', '/api/invites').then((r) => r.json), { invites: [], pendingCount: 0 });
  assert.equal((await anon('GET', '/api/invites')).status, 401);
});

test('five waiting invites to one person is the most, and asking again about one of them is still answered', async () => {
  for (const group of RATE.slice(0, 5)) {
    const sent = await alice('POST', '/api/invites', { kind: 'event', ref: group, username: 'Pool1' });
    assert.equal(sent.status, 201, group);
    if (group === RATE[0]) poolInvite = sent.json.invite.id;
  }
  const sixth = await alice('POST', '/api/invites', { kind: 'event', ref: RATE[5], username: 'Pool1' });
  assert.equal(sixth.status, 429);
  assert.match(sixth.json.error, /5/);
  assert.equal((await alice('POST', '/api/invites', { kind: 'event', ref: RATE[0], username: 'Pool1' })).json.invite.id, poolInvite, 'the same one, not refused');
  assert.equal((await pool[0]('GET', '/api/invites')).json.pendingCount, 5);
});

test('an hour allows thirty new invites from one sender, and asking again about one already sent costs nothing', async () => {
  // Alice has sent seven. Twenty-three more go to five people, so none of them reaches the five-a-person limit.
  for (let j = 5; j < 28; j++) assert.equal((await alice('POST', '/api/invites', { kind: 'event', ref: RATE[j], username: POOL[1 + (j % 5)] })).status, 201, RATE[j]);
  const limited = await alice('POST', '/api/invites', { kind: 'event', ref: RATE[28], username: 'Bobby' });
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /30/);
  const again = await alice('POST', '/api/invites', { kind: 'event', ref: RATE[0], username: 'Pool1' });
  assert.equal(again.status, 201, 'one already sent is answered, not refused');
  assert.equal(again.json.invite.id, poolInvite);

  // Erin has her own hour: six people, five each.
  for (let j = 28; j < 58; j++) assert.equal((await erin('POST', '/api/invites', { kind: 'event', ref: RATE[j], username: POOL[j % 6] })).status, 201, RATE[j]);
  assert.equal((await erin('POST', '/api/invites', { kind: 'event', ref: RATE[58], username: 'Pool7' })).status, 429);
});

test('the waiting list is capped at fifty, the count is all of them, and it is newest first', async () => {
  // Eleven senders with five each: fifty-five waiting for Bobby, on top of Alice's two.
  for (let s = 0; s < 11; s++) {
    for (let k = 0; k < 5; k++) {
      const sent = await senders[s]('POST', '/api/invites', { kind: 'event', ref: RATE[s * 5 + k], username: 'Bobby' });
      assert.equal(sent.status, 201, `${s}/${k}`);
      if (s === 0 && k === 0) senderInvite = sent.json.invite.id;
    }
  }
  const list = (await bob('GET', '/api/invites')).json;
  assert.equal(list.pendingCount, 57, 'every waiting invite is counted');
  assert.equal(list.invites.length, 50, 'the list is capped');
  const times = list.invites.map((i: { createdAt: string }) => i.createdAt);
  assert.deepEqual([...times].sort().reverse(), times, 'newest first');
});

test('accepting is going, dismissing takes an invite off the list, and only the recipient can answer', async () => {
  assert.equal((await bob('POST', `/api/invites/${eventInvite}/accept`)).json.ok, true);
  assert.equal((await bob('GET', '/api/events/ok-1/rsvp')).json.rsvp.mine, 'going');
  assert.equal((await bob('POST', `/api/invites/${communityInvite}/accept`)).status, 200);
  assert.equal((await bob('GET', `/api/community-events/${communityId}/rsvp`)).json.rsvp.mine, 'going');
  assert.equal((await bob('GET', '/api/invites')).json.pendingCount, 55, 'accepted ones are not waiting');

  // Bob changes his mind on both; a replayed accept must not put either back.
  assert.equal((await bob('PUT', '/api/events/ok-1/rsvp', { status: 'interested' })).status, 200);
  assert.equal((await bob('DELETE', `/api/community-events/${communityId}/rsvp`)).status, 200);
  assert.deepEqual((await bob('POST', `/api/invites/${eventInvite}/accept`)).json, { ok: true }, 'twice is fine');
  assert.deepEqual((await bob('POST', `/api/invites/${communityInvite}/accept`)).json, { ok: true });
  assert.equal((await bob('GET', '/api/events/ok-1/rsvp')).json.rsvp.mine, 'interested');
  assert.equal((await bob('GET', `/api/community-events/${communityId}/rsvp`)).json.rsvp.mine, null);

  assert.equal((await alice('POST', `/api/invites/${poolInvite}/accept`)).status, 404, 'the sender cannot accept it');
  assert.equal((await erin('POST', `/api/invites/${poolInvite}/dismiss`)).status, 404, 'nor can someone else dismiss it');
  assert.equal((await alice('POST', `/api/invites/${poolInvite}/dismiss`)).status, 404);
  assert.equal((await bob('POST', '/api/invites/no-such-invite/accept')).status, 404);
  assert.equal((await anon('POST', `/api/invites/${poolInvite}/dismiss`)).status, 401);

  assert.equal((await bob('POST', `/api/invites/${senderInvite}/dismiss`)).json.ok, true);
  assert.equal((await bob('POST', `/api/invites/${senderInvite}/dismiss`)).status, 200, 'twice is fine');
  assert.equal((await bob('GET', '/api/invites')).json.pendingCount, 54);
  // Dismissed stays dismissed: sending it again returns the same invite, and it does not come back to the list.
  assert.equal((await senders[0]('POST', '/api/invites', { kind: 'event', ref: RATE[0], username: 'Bobby' })).json.invite.status, 'dismissed');
  // Nor can a dismissed one be accepted after the fact: it answers ok, gives no answer, and stays dismissed.
  assert.deepEqual((await bob('POST', `/api/invites/${senderInvite}/accept`)).json, { ok: true });
  assert.equal((await bob('GET', `/api/events/${RATE[0]}/rsvp`)).json.rsvp.mine, null);
  assert.equal((await bob('GET', '/api/invites')).json.pendingCount, 54);
});

test('an invite whose event has left the list still shows, with no event', async () => {
  assert.equal((await frank('POST', '/api/invites', { kind: 'event', ref: 'ok-3', username: 'Bobby' })).status, 201);
  show('ok-1', ...RATE);
  const list = (await bob('GET', '/api/invites')).json;
  assert.equal(list.invites[0].from.username, 'Frank');
  assert.equal(list.invites[0].event, null);
  assert.equal(list.pendingCount, 55);
  show('ok-1', 'ok-3', ...RATE);
});

test('deleting an account takes its RSVPs and its invites, and an invite to one of its events goes too', async () => {
  const gilEvent = (await gil('POST', '/api/community-events', meet())).json.id;
  assert.equal((await frank('POST', '/api/invites', { kind: 'community', ref: gilEvent, username: 'Bobby' })).status, 201);
  assert.equal((await bob('GET', '/api/invites')).json.pendingCount, 56);
  assert.equal((await erin('PUT', '/api/events/ok-1/rsvp', { status: 'going' })).status, 200);
  assert.equal((await anon('GET', '/api/events/ok-1/rsvp')).json.rsvp.going, 1);
  assert.equal((await pool[0]('GET', '/api/invites')).json.pendingCount, 10, 'Pool1 has five from Alice and five from Erin');

  assert.equal((await admin('DELETE', `/api/users/${erinId}`)).status, 200);
  assert.deepEqual((await anon('GET', '/api/events/ok-1/rsvp')).json.rsvp, { going: 0, interested: 1, mine: null, attendees: [] }, 'her answer went with her');
  assert.equal((await pool[0]('GET', '/api/invites')).json.pendingCount, 5, 'and so did the five she sent');

  assert.equal((await admin('DELETE', `/api/users/${gilId}`)).status, 200);
  const left = (await bob('GET', '/api/invites')).json;
  assert.equal(left.pendingCount, 55, 'the invite to his event went with it');
  assert.equal(left.invites.some((i: { ref: string }) => i.ref === gilEvent), false);
});

test('user search: by the start of a handle, not you, not suspended people, at most eight, two letters or more', async () => {
  for (const name of ['Sea_x', 'Seaweed', 'Searcha']) await app.signIn(app.client(), 'google', { id: `s-${name}`, name });
  for (let i = 1; i <= 9; i++) await app.signIn(app.client(), 'google', { id: `c-${i}`, name: `Crowd${i}` });
  const names = async (c: typeof alice, q: string) => {
    const r = await c('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, q);
    return r.json.map((u: { username: string }) => u.username).sort();
  };
  assert.deepEqual(await names(bob, 'sea'), ['Sea_x', 'Searcha', 'Seaweed']);
  assert.deepEqual(await names(bob, 'SEARCH'), ['Searcha']);
  assert.deepEqual(await names(bob, 'sea_'), ['Sea_x'], 'the underscore is a letter, not a wildcard');
  assert.equal((await bob('GET', '/api/users/search?q=sea')).json[0].avatar, '');
  assert.deepEqual(Object.keys((await bob('GET', '/api/users/search?q=sea')).json[0]).sort(), ['avatar', 'id', 'username']);
  assert.deepEqual(await names(bob, 's'), [], 'one letter is nothing');
  assert.deepEqual(await names(bob, ''), []);
  assert.deepEqual(await names(bob, 'se%'), [], 'a wildcard is not a search');
  assert.deepEqual(await names(alice, 'al'), [], 'not you');
  assert.deepEqual(await names(bob, 'ca'), [], 'a suspended account');
  assert.deepEqual(await names(bob, 'da'), [], 'a suspended account');
  assert.equal((await bob('GET', '/api/users/search?q=crowd')).json.length, 8);
  assert.equal((await anon('GET', '/api/users/search?q=sea')).status, 401);
});
