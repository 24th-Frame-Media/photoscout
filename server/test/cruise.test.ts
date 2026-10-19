import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';
import { connected } from './socketHelpers.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

const HOUR = 3_600_000;
const inHours = (n: number) => new Date(Date.now() + n * HOUR).toISOString();
const line: [number, number][] = [[149.58, -33.42], [149.6, -33.43], [149.65, -33.45]];
const meet = () => ({ lat: -33.42, lng: 149.58, note: 'Servo car park, bring a full tank' });
const event = (cruise?: unknown) => ({
  title: 'Sunset cruise', description: '', startTime: inHours(48), endTime: inHours(54), venueName: '', address: '',
  lat: -33.42, lng: 149.58, priceText: '', visibility: 'public', ...(cruise === undefined ? {} : { cruise }),
});
const ROLL_OUT = inHours(49);
const drawn = (extra: Record<string, unknown> = {}) => ({ vertices: line, meet: meet(), rollOut: ROLL_OUT, ...extra });
const saved = (vis: 'private' | 'public', extra: Record<string, unknown> = {}) => ({
  name: 'Secret back road', notes: 'The gate code is 1234', access: 'Ask the farmer', type: 'circuit', vertices: line, staging: { lat: -33.5, lng: 149.5 }, visibility: vis, ...extra,
});

test('a drawn route, a meeting point and a roll-out time; the list leaves the line out', async () => {
  const made = await alice('POST', '/api/community-events', event(drawn({ name: 'Coast run' })));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.cruise.route.name, 'Coast run');
  assert.deepEqual(made.json.cruise.route.vertices, line);
  assert.equal(made.json.cruise.meet.note, 'Servo car park, bring a full tank');
  assert.equal(made.json.cruise.rollOut, ROLL_OUT);

  const one = await anon('GET', `/api/community-events/${made.json.id}`);
  assert.deepEqual(one.json.cruise.route.vertices, line, 'the detail has the line, for anybody');
  const listed = (await anon('GET', '/api/community-events')).json.find((e: { id: string }) => e.id === made.json.id);
  assert.equal(listed.cruise.route.vertices, undefined);
  assert.equal(listed.cruise.route.name, 'Coast run');

  const plain = await alice('POST', '/api/community-events', event());
  assert.equal(plain.json.cruise, null);
});

test('attaching a saved route copies the line, and only the line', async () => {
  const route = (await alice('POST', '/api/routes', saved('private'))).json;
  assert.equal((await bob('GET', `/api/routes/${route.id}`)).status, 404, 'the route itself stays private');

  const made = await alice('POST', '/api/community-events', event({ routeId: route.id, meet: meet(), rollOut: inHours(50) }));
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const seen = (await bob('GET', `/api/community-events/${made.json.id}`)).json.cruise;
  assert.deepEqual(seen.route.vertices, line, 'whoever can see the event can see the line');
  assert.equal(seen.route.type, 'circuit');
  const everything = JSON.stringify((await anon('GET', `/api/community-events/${made.json.id}`)).json);
  for (const secret of ['1234', 'farmer', route.id, '-33.5']) assert.ok(!everything.includes(secret), `${secret} leaked`);

  // It is a copy: the saved route can change or go without touching the cruise.
  await alice('PATCH', `/api/routes/${route.id}`, { vertices: [[0, 0], [1, 1]], name: 'Renamed' });
  await alice('DELETE', `/api/routes/${route.id}`);
  assert.deepEqual((await anon('GET', `/api/community-events/${made.json.id}`)).json.cruise.route.vertices, line);
});

test('only routes the organiser can see can be attached', async () => {
  const theirs = (await bob('POST', '/api/routes', saved('private'))).json;
  const open = (await bob('POST', '/api/routes', saved('public', { name: 'Public loop' }))).json;
  const refused = await alice('POST', '/api/community-events', event({ routeId: theirs.id, meet: meet(), rollOut: inHours(50) }));
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /No such route/);
  const gone = await alice('POST', '/api/community-events', event({ routeId: 'nope', meet: meet(), rollOut: inHours(50) }));
  assert.equal(gone.json.error, refused.json.error, 'a private route and a missing one look the same');
  const fine = await alice('POST', '/api/community-events', event({ routeId: open.id, meet: meet(), rollOut: inHours(50) }));
  assert.equal(fine.status, 201, 'a public route is visible to the organiser');

  // An admin editing the event is not a way to attach a route the organiser could not.
  const mine = (await alice('POST', '/api/community-events', event())).json;
  const adminsOwn = (await admin('POST', '/api/routes', saved('private'))).json;
  const viaAdmin = await admin('PATCH', `/api/community-events/${mine.id}`, { cruise: { routeId: adminsOwn.id, meet: meet(), rollOut: inHours(50) } });
  assert.equal(viaAdmin.status, 403);
  // And editing as the organiser, a route that is someone else's private one still is not allowed.
  const viaEdit = await alice('PATCH', `/api/community-events/${mine.id}`, { cruise: { routeId: theirs.id, meet: meet(), rollOut: inHours(50) } });
  assert.equal(viaEdit.status, 400);
});

test('only the organiser edits the cruise; staff can take it off', async () => {
  const made = (await alice('POST', '/api/community-events', event(drawn()))).json;
  assert.equal((await bob('PATCH', `/api/community-events/${made.id}`, { cruise: drawn({ name: 'Mine now' }) })).status, 403);
  assert.equal((await bob('PATCH', `/api/community-events/${made.id}`, { cruise: null })).status, 403);

  const moved = await alice('PATCH', `/api/community-events/${made.id}`, { cruise: { meet: { lat: -33.1, lng: 149.1, note: 'New spot' }, rollOut: inHours(52) } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual(moved.json.cruise.route.vertices, line, 'the route is kept when only the meeting point changes');
  assert.equal(moved.json.cruise.meet.note, 'New spot');
  const titled = await alice('PATCH', `/api/community-events/${made.id}`, { title: 'Renamed' });
  assert.equal(titled.json.cruise.meet.note, 'New spot', 'an edit that leaves the cruise out keeps it');

  assert.equal((await admin('PATCH', `/api/community-events/${made.id}`, { cruise: null })).json.cruise, null);
});

test('the cruise is checked: route, meeting point and a roll-out time inside the event', async () => {
  const bad = async (cruise: unknown, why: RegExp) => {
    const r = await alice('POST', '/api/community-events', event(cruise));
    assert.equal(r.status, 400, JSON.stringify(cruise));
    assert.match(r.json.error, why);
  };
  await bad({ meet: meet(), rollOut: inHours(49) }, /saved route or draw/);
  await bad(drawn({ routeId: 'x' }), /not both/);
  await bad(drawn({ vertices: [[1, 1]] }), /two points/);
  await bad(drawn({ vertices: [[1, 91]] }), /outside valid/);
  await bad(drawn({ vertices: 'a line' }), /array/);
  await bad(drawn({ vertices: Array.from({ length: 10_001 }, (_, i) => [149 + i * 1e-5, -33]) }), /10000 points/);
  await bad(drawn({ meet: undefined }), /meeting point/);
  await bad(drawn({ meet: { lat: 100, lng: 0 } }), /latitude/);
  await bad(drawn({ meet: { lat: 0, lng: 0, note: 'x'.repeat(201) } }), /note/);
  await bad(drawn({ rollOut: undefined }), /rollOut/);
  await bad(drawn({ rollOut: 'soon' }), /rollOut/);
  await bad(drawn({ rollOut: inHours(47) }), /while the event is on/);
  await bad(drawn({ rollOut: inHours(55) }), /while the event is on/);
  await bad('a cruise', /object/);
  await bad(drawn({ type: 'zigzag' }), /sprint or circuit/);
});

test('moving the event cannot leave a roll-out time outside it', async () => {
  const made = (await alice('POST', '/api/community-events', event(drawn()))).json;
  const later = await alice('PATCH', `/api/community-events/${made.id}`, { startTime: inHours(100), endTime: inHours(104) });
  assert.equal(later.status, 400);
  assert.match(later.json.error, /roll-out/);
  const together = await alice('PATCH', `/api/community-events/${made.id}`, { startTime: inHours(100), endTime: inHours(104), cruise: { rollOut: inHours(101) } });
  assert.equal(together.status, 200, JSON.stringify(together.json));
});

test('the organiser starts the convoy, and those going join it with one message', async () => {
  const made = (await alice('POST', '/api/community-events', event(drawn({ type: 'circuit' })))).json;
  const plain = (await alice('POST', '/api/community-events', event())).json;
  const a = await connected(app.socket(alice));
  const b = await connected(app.socket(bob));

  b.send({ t: 'convoy.cruise', eventId: made.id });
  assert.match((await b.next((m) => m.t === 'error')).error, /Say you are going/);
  await bob('PUT', `/api/community-events/${made.id}/rsvp`);
  b.send({ t: 'convoy.cruise', eventId: made.id });
  assert.match((await b.next((m) => m.t === 'error')).error, /organiser has not started/);

  a.send({ t: 'convoy.cruise', eventId: plain.id });
  assert.match((await a.next((m) => m.t === 'error')).error, /No such cruise/, 'an event with no cruise has no convoy');

  a.send({ t: 'convoy.cruise', eventId: made.id });
  const room = (await a.next((m) => m.t === 'room')).room;
  assert.equal(room.eventId, made.id);
  assert.equal(room.name, 'Sunset cruise');
  assert.deepEqual(room.destination, { lat: -33.42, lng: 149.58, label: 'Servo car park, bring a full tank' });
  assert.deepEqual(room.route, { name: 'Cruise route', stops: [...line, line[0]] });
  // Asking again is the same convoy.
  a.send({ t: 'convoy.cruise', eventId: made.id });
  assert.equal((await a.next((m) => m.t === 'room')).room.code, room.code);

  b.send({ t: 'convoy.cruise', eventId: made.id });
  const joined = await b.next((m) => m.t === 'room');
  assert.equal(joined.room.code, room.code);
  assert.equal(joined.room.members.length, 2);

  // Not going any more does not put you out, but a stranger who never RSVP'd cannot get in.
  const carol = app.client();
  await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
  const c = await connected(app.socket(carol));
  c.send({ t: 'convoy.cruise', eventId: made.id });
  assert.match((await c.next((m) => m.t === 'error')).error, /Say you are going/);
  a.ws.close(); b.ws.close(); c.ws.close();
});
