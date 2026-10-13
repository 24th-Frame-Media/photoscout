import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type Client } from './httpHarness.js';
import { connected, refusal } from './socketHelpers.js';

// A short heartbeat so the dead-socket test does not take half a minute.
const app = await startApp({ ADMIN_IDS: 'discord:900' }, { heartbeatMs: 200 });
const { db } = await import('../src/db.js');
const { MAX_MEMBERS, MAX_ROOMS_PER_USER } = await import('../src/convoy.js');
after(() => app.close());

const people: Record<string, Client> = {};
async function person(name: string, id = name): Promise<Client> {
  const c = app.client();
  await app.signIn(c, 'google', { id, name });
  return (people[name] = c);
}
const alice = await person('Alice', '111');
const bob = await person('Bobby', '222');
const carol = await person('Carol', '333');
const admin = app.client();
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
const idOf = async (c: Client): Promise<string> => (await c('GET', '/api/auth/status')).json.user.id;

/** Out of every convoy, so one test's rooms do not count against the next test's three. */
async function leaveAll(...clients: Client[]): Promise<void> {
  for (const c of clients) {
    const box = await connected(app.socket(c));
    for (const room of box.all[0].rooms) { box.send({ t: 'convoy.leave', room: room.code }); await box.next((m) => m.t === 'left'); }
    box.ws.close();
  }
}
const create = async (box: Awaited<ReturnType<typeof connected>>, name = 'Run') => {
  box.send({ t: 'convoy.create', name });
  return (await box.next((m) => m.t === 'room' && m.room.name === name)).room;
};

test('a socket needs a session cookie and this site as its Origin', async () => {
  assert.equal(await refusal(app.socket(undefined, { cookie: null })), 401, 'no cookie');
  assert.equal(await refusal(app.socket(alice, { cookie: '__Host-ps_session=not-a-real-session' })), 401, 'a made-up session');
  assert.equal(await refusal(app.socket(alice, { origin: 'https://evil.example' })), 403, 'another site');
  assert.equal(await refusal(app.socket(alice, { origin: 'http://photoscout.test' })), 403, 'the right host on the wrong scheme');
  const ok = await connected(app.socket(alice));
  assert.equal(ok.all[0].me, await idOf(alice));
  ok.ws.close();
  // Only /ws is a socket.
  const stray = new (await import('ws')).WebSocket(`${app.base.replace('http', 'ws')}/api/chat`, { headers: { Origin: 'https://photoscout.test' } });
  stray.on('error', () => {});
  assert.equal(await new Promise((r) => stray.once('close', r)), 1006);
});

test('suspending an account, or signing out, closes its sockets', async () => {
  const dave = await person('Dave', '444');
  const eve = await person('Eve', '555');
  const mine = await connected(app.socket(dave));
  const second = await connected(app.socket(dave));
  const evesBox = await connected(app.socket(eve));

  const ban = await admin('PATCH', `/api/users/${await idOf(dave)}`, { banned: true });
  assert.equal(ban.status, 200);
  assert.equal(await mine.closed, 4401);
  assert.equal(await second.closed, 4401);
  assert.equal(await refusal(app.socket(dave)), 401, 'and cannot come back');

  assert.equal(evesBox.ws.readyState, evesBox.ws.OPEN, 'someone else is left alone');
  await eve('POST', '/api/auth/logout');
  assert.equal(await evesBox.closed, 4401);
});

test('a session that just runs out ends its socket at the next heartbeat', async () => {
  const frank = await person('Frank', '666');
  const box = await connected(app.socket(frank));
  db.handle.prepare('DELETE FROM sessions WHERE user_id = ?').run(await idOf(frank));
  assert.equal(await box.closed, 4401);
});

test('a socket that stops answering pings is dropped', async () => {
  const box = await connected(app.socket(alice, { autoPong: false }));
  const code = await Promise.race([box.closed, new Promise<string>((r) => setTimeout(() => r('still open'), 3000))]);
  assert.equal(code, 1006);
});

test('join by code works, a wrong code fails, and the convoy shows everyone', async () => {
  const a = await connected(app.socket(alice));
  const b = await connected(app.socket(bob));
  const room = await create(a, 'Sunday run');
  assert.match(room.code, /^[A-HJ-KM-NP-Z2-9]{8}$/);
  assert.equal(room.leader, await idOf(alice));
  assert.equal(room.members.length, 1);

  b.send({ t: 'convoy.join', code: '22222222' });
  assert.match((await b.next((m) => m.t === 'error')).error, /No convoy has that code/);
  b.send({ t: 'convoy.join', code: 'short' });
  assert.match((await b.next((m) => m.t === 'error')).error, /not a convoy code/);

  b.send({ t: 'convoy.join', code: room.code.toLowerCase() });
  const joined = await b.next((m) => m.t === 'room' && m.room.members.length === 2);
  assert.deepEqual(joined.room.members.map((m: { username: string }) => m.username), ['Alice', 'Bobby']);
  assert.deepEqual(Object.keys(joined.room.members[0]).sort(), ['avatar', 'id', 'lastSeen', 'online', 'position', 'username']);
  await a.next((m) => m.t === 'room' && m.room.members.length === 2);

  // Only the leader sets where it is going.
  b.send({ t: 'convoy.dest', room: room.code, destination: { lat: 1, lng: 2, label: 'Nope' } });
  assert.match((await b.next((m) => m.t === 'error')).error, /Only the leader/);
  a.send({ t: 'convoy.dest', room: room.code, destination: { lat: -33.4, lng: 149.5, label: 'Mount Panorama' } });
  const dest = await b.next((m) => m.t === 'room' && m.room.destination);
  assert.deepEqual(dest.room.destination, { lat: -33.4, lng: 149.5, label: 'Mount Panorama' });

  // Leading can be handed over.
  const bobId = await idOf(bob);
  a.send({ t: 'convoy.lead', room: room.code, to: bobId });
  await b.next((m) => m.t === 'room' && m.room.leader === bobId);
  await a.next((m) => m.t === 'room' && m.room.leader === bobId);
  a.ws.close();
  b.ws.close();
  await leaveAll(alice, bob);
});

test('positions reach the others, are throttled, stop on leave and on disconnect, and are never stored', async () => {
  const lat = -33.8688197, lng = 151.2092955;
  const a = await connected(app.socket(alice));
  const b = await connected(app.socket(bob));
  const room = await create(a, 'Positions');
  b.send({ t: 'convoy.join', code: room.code });
  await a.next((m) => m.t === 'room' && m.room.members.length === 2);
  const aliceId = await idOf(alice);

  a.send({ t: 'pos', lat, lng, heading: 270, speed: 22.5 });
  const got = await b.next((m) => m.t === 'pos');
  assert.equal(got.id, aliceId);
  assert.equal(got.room, room.code);
  assert.deepEqual([got.lat, got.lng, got.heading, got.speed], [lat, lng, 270, 22.5]);
  assert.ok(Math.abs(got.ts - Date.now()) < 5000, 'stamped by the server');
  assert.equal(await a.quietly((m) => m.t === 'pos'), 0, 'not echoed to the sender');

  // The next four inside the same second are dropped.
  for (let i = 0; i < 4; i++) a.send({ t: 'pos', lat: lat + 0.001 * (i + 1), lng, heading: null, speed: null });
  assert.equal(await b.quietly((m) => m.t === 'pos', 300), 0);

  // A late joiner is handed the latest position with the list.
  const c = await connected(app.socket(carol));
  c.send({ t: 'convoy.join', code: room.code });
  const seen = await c.next((m) => m.t === 'room' && m.room.members.length === 3);
  assert.equal(seen.room.members.find((m: { username: string }) => m.username === 'Alice').position.lat, lat);

  // Nothing is in the database: not as a number, not as text.
  const dump = JSON.stringify(
    (db.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => db.handle.prepare(`SELECT * FROM "${t.name}"`).all()),
    (_k, v) => (typeof v === 'bigint' ? String(v) : v),
  );
  assert.ok(!dump.includes('33.8688197') && !dump.includes('151.2092955'), 'a position is in a table');

  // Bobby drives off the end of coverage: Alice sees him drop, with no position.
  b.ws.close();
  const dropped = await a.next((m) => m.t === 'room' && m.room.members.some((x: { username: string; online: boolean }) => x.username === 'Bobby' && !x.online));
  const gone = dropped.room.members.find((m: { username: string }) => m.username === 'Bobby');
  assert.equal(gone.position, null);
  assert.ok(gone.lastSeen > 0);

  // Carol leaves: the others stop seeing her, and she hears it.
  c.send({ t: 'convoy.leave', room: room.code });
  await c.next((m) => m.t === 'left' && m.room === room.code);
  const after = await a.next((m) => m.t === 'room' && m.room.members.length === 2);
  assert.ok(!after.room.members.some((m: { username: string }) => m.username === 'Carol'));
  // ...and what she sends now goes nowhere.
  c.send({ t: 'pos', lat: 1, lng: 1, heading: null, speed: null });
  assert.equal(await a.quietly((m) => m.t === 'pos' && m.id !== aliceId, 300), 0);

  // Reconnecting picks the convoy back up.
  const again = await connected(app.socket(bob));
  assert.equal(again.all[0].rooms[0].code, room.code);
  a.ws.close(); c.ws.close(); again.ws.close();
  await leaveAll(alice, bob, carol);
});

test('a leader can remove someone who got the code', async () => {
  const a = await connected(app.socket(alice));
  const b = await connected(app.socket(bob));
  const room = await create(a, 'Private');
  b.send({ t: 'convoy.join', code: room.code });
  const bobId = (await b.next((m) => m.t === 'room' && m.room.members.length === 2)).room.members[1].id;

  b.send({ t: 'convoy.remove', room: room.code, id: await idOf(alice) });
  assert.match((await b.next((m) => m.t === 'error')).error, /Only the leader/);
  a.send({ t: 'convoy.remove', room: room.code, id: bobId });
  assert.equal((await b.next((m) => m.t === 'left')).removed, true);
  assert.equal((await a.next((m) => m.t === 'room' && m.room.members.length === 1)).room.members[0].username, 'Alice');
  b.send({ t: 'convoy.join', code: room.code });
  assert.match((await b.next((m) => m.t === 'error')).error, /removed you/);
  a.ws.close(); b.ws.close();
  await leaveAll(alice, bob);
});

test('the room is capped at 30, and a person at 3 convoys', async () => {
  const owner = await connected(app.socket(alice));
  const room = await create(owner, 'Full');
  const joiners = [];
  for (let i = 1; i < MAX_MEMBERS; i++) {
    const c = await person(`Driver${i}`, `d${i}`);
    const box = await connected(app.socket(c));
    box.send({ t: 'convoy.join', code: room.code });
    await box.next((m) => m.t === 'room');
    joiners.push(box);
  }
  const late = await person('Latecomer', 'late');
  const box = await connected(app.socket(late));
  box.send({ t: 'convoy.join', code: room.code });
  assert.match((await box.next((m) => m.t === 'error')).error, /full/);
  // Twenty-nine people, and the owner: a freed place can be taken.
  joiners[0].send({ t: 'convoy.leave', room: room.code });
  await joiners[0].next((m) => m.t === 'left');
  box.send({ t: 'convoy.join', code: room.code });
  assert.equal((await box.next((m) => m.t === 'room')).room.members.length, MAX_MEMBERS);

  const busy = await connected(app.socket(late));
  for (let i = 1; i < MAX_ROOMS_PER_USER; i++) await create(busy, `Extra ${i}`);
  busy.send({ t: 'convoy.create', name: 'One too many' });
  assert.match((await busy.next((m) => m.t === 'error')).error, /3 convoys/);
  for (const j of joiners) j.ws.close();
  owner.ws.close(); box.ws.close(); busy.ws.close();
});

test('a flood is dropped, then the socket is closed; big, binary and malformed messages are refused', async () => {
  const c = await connected(app.socket(carol));
  c.ws.send('not json');
  assert.match((await c.next((m) => m.t === 'error')).error, /JSON/);
  c.ws.send(JSON.stringify({ t: 'pos', lat: 200, lng: 0 }));
  assert.match((await c.next((m) => m.t === 'error')).error, /lat/);
  assert.equal(c.ws.readyState, c.ws.OPEN, 'bad messages alone do not end the socket');

  const flood = await connected(app.socket(carol));
  for (let i = 0; i < 300; i++) flood.ws.send('{"t":"nope"}');
  assert.equal(await flood.closed, 1008);
  const answered = flood.all.filter((m) => m.t === 'error').length;
  assert.ok(answered >= 10 && answered <= 15, `${answered} of 300 were answered; the rest were dropped`);

  const big = await connected(app.socket(carol));
  big.ws.send(JSON.stringify({ t: 'convoy.create', name: 'x'.repeat(5000) }));
  assert.equal(await big.closed, 1009);

  const bin = await connected(app.socket(carol));
  bin.ws.send(Buffer.from([1, 2, 3]));
  assert.equal(await bin.closed, 1003);
  c.ws.close();
});

test('a chat line is pushed to the sockets that subscribed, and so is its removal', async () => {
  const listener = await connected(app.socket(bob));
  const deaf = await connected(app.socket(carol));
  listener.send({ t: 'chat.sub' });
  await listener.next((m) => m.t === 'chat.ready');

  const posted = await alice('POST', '/api/chat', { body: 'Anyone at the lookout?' });
  assert.equal(posted.status, 201);
  const pushed = await listener.next((m) => m.t === 'chat');
  assert.deepEqual(pushed.message, posted.json);
  assert.equal(await deaf.quietly((m) => m.t === 'chat'), 0, 'not subscribed, not told');

  assert.equal((await alice('DELETE', `/api/chat/${posted.json.id}`)).status, 200);
  assert.equal((await listener.next((m) => m.t === 'chat.gone')).id, posted.json.id);

  // A line a moderator hides on a report goes the same way.
  const rude = await alice('POST', '/api/chat', { body: 'something rude' });
  await listener.next((m) => m.t === 'chat' && m.message.id === rude.json.id);
  const filed = await bob('POST', '/api/reports', { targetKind: 'chat', targetId: rude.json.id, reason: 'rude' });
  assert.equal(filed.status, 201);
  const queue = await admin('GET', '/api/reports');
  const report = queue.json.find((r: { target_id: string }) => r.target_id === rude.json.id);
  assert.equal((await admin('POST', `/api/reports/${report.id}/resolve`, { action: 'hide' })).status, 200);
  assert.equal((await listener.next((m) => m.t === 'chat.gone')).id, rude.json.id);

  // Unsubscribed, the socket hears nothing more.
  listener.send({ t: 'chat.unsub' });
  await new Promise((r) => setTimeout(r, 100));
  await alice('POST', '/api/chat', { body: 'still here' });
  assert.equal(await listener.quietly((m) => m.t === 'chat', 300), 0);
  listener.ws.close(); deaf.ws.close();
});

test('history over REST still holds the thirty-minute window the socket does not replace', async () => {
  const bodies = (await bob('GET', '/api/chat')).json.map((m: { body: string }) => m.body);
  assert.ok(bodies.includes('still here'));
  assert.ok(!bodies.includes('something rude'));
});
