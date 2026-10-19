import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CONVOY_CHAT_GAP_MS, CONVOY_MESSAGE_TTL_MS, MAX_CONVOY_MESSAGES, Rooms } from '../src/convoy.js';
import { parseClientMessage } from '../src/wsMessages.js';
import { startApp } from './httpHarness.js';
import { connected } from './socketHelpers.js';

test('convoy messages require membership, authenticate their sender, deduplicate retries and expire', () => {
  let now = 10_000;
  const rooms = new Rooms(() => now);
  const made = rooms.create({ id: 'a', username: 'Alice', avatar: '' });
  assert.ok(made.ok);
  const code = made.value.code;
  assert.equal(rooms.message(code, 'outsider', 'Hello', '1').ok, false);
  const first = rooms.message(code, 'a', ' Hello ', '1');
  assert.ok(first.ok);
  assert.equal(first.value.username, 'Alice');
  assert.equal(first.value.text, 'Hello');
  assert.deepEqual(rooms.message(code, 'a', 'different retry text', '1'), first);
  assert.equal(rooms.message(code, 'a', 'Too soon', '2').ok, false);
  assert.equal(rooms.message(code, 'a', 'x'.repeat(501), '3').ok, false);
  for (let i = 0; i < MAX_CONVOY_MESSAGES + 10; i++) {
    now += CONVOY_CHAT_GAP_MS;
    assert.ok(rooms.message(code, 'a', `Message ${i}`, `many-${i}`).ok);
  }
  assert.equal(rooms.view(code)!.messages.length, MAX_CONVOY_MESSAGES);
  now += CONVOY_MESSAGE_TTL_MS;
  assert.deepEqual(rooms.view(code)!.messages, []);
});

test('rest lookups share a cooldown and a destination change invalidates pending results', () => {
  const rooms = new Rooms();
  const made = rooms.create({ id: 'a', username: 'Alice', avatar: '' }, { route: { name: 'Route', stops: [[149, -33], [150, -33]] } });
  assert.ok(made.ok);
  const code = made.value.code;
  rooms.join(code, { id: 'b', username: 'Bob', avatar: '' });
  const reserved = rooms.reserveRestLookup(code, 'a');
  assert.ok(reserved.ok);
  assert.equal(rooms.reserveRestLookup(code, 'b').ok, false);
  rooms.setDestination(code, 'a', { lat: -33, lng: 150, label: 'Changed' });
  assert.notEqual(rooms.navigationVersion(code), reserved.value);
});

test('convoy message parser rejects empty, oversize and missing ids and drops spoofed identities', () => {
  const base = { t: 'convoy.message', room: 'ROOM', text: 'Wait for me', clientId: '123' };
  assert.deepEqual(parseClientMessage(JSON.stringify({ ...base, userId: 'spoof', username: 'spoof' })), { ok: true, message: base });
  for (const patch of [{ text: '' }, { text: 'x'.repeat(501) }, { clientId: '' }, { room: '' }]) assert.equal(parseClientMessage(JSON.stringify({ ...base, ...patch })).ok, false);
});

const app = await startApp();
after(() => app.close());

test('convoy chat is private, acknowledged, replayed on reconnect and inaccessible after removal', async () => {
  const a = app.client(), b = app.client(), outsider = app.client();
  await app.signIn(a, 'google', { id: 'convoy-a', name: 'Alice' });
  await app.signIn(b, 'google', { id: 'convoy-b', name: 'Bob' });
  await app.signIn(outsider, 'google', { id: 'convoy-c', name: 'Carol' });
  const abox = await connected(app.socket(a));
  const bbox = await connected(app.socket(b));
  const cbox = await connected(app.socket(outsider));
  abox.send({ t: 'convoy.create', name: 'Private ride' });
  const room = (await abox.next((m) => m.t === 'room')).room;
  bbox.send({ t: 'convoy.join', code: room.code });
  await bbox.next((m) => m.t === 'room');
  abox.send({ t: 'convoy.message', room: room.code, text: 'Wait for me', clientId: 'one', username: 'Spoof' });
  const received = await bbox.next((m) => m.t === 'convoy.message');
  const ack = await abox.next((m) => m.t === 'convoy.message');
  assert.equal(received.message.username, 'Alice');
  assert.deepEqual(ack.message, received.message);
  assert.equal(await cbox.quietly((m) => m.t === 'convoy.message'), 0);
  cbox.send({ t: 'convoy.message', room: room.code, text: 'Intrusion', clientId: 'outsider' });
  assert.match((await cbox.next((m) => m.t === 'error')).error, /not in/);
  bbox.ws.close();
  await bbox.closed;
  const reconnect = await connected(app.socket(b));
  assert.equal(reconnect.all[0].rooms[0].messages[0].id, received.message.id);
  abox.send({ t: 'convoy.remove', room: room.code, id: reconnect.all[0].me });
  await reconnect.next((m) => m.t === 'left');
  reconnect.send({ t: 'convoy.message', room: room.code, text: 'After removal', clientId: 'removed' });
  assert.match((await reconnect.next((m) => m.t === 'error')).error, /not in/);
  abox.send({ t: 'ping' });
  await abox.next((m) => m.t === 'pong');
  abox.ws.close(); reconnect.ws.close(); cbox.ws.close();
});

test('an expired session is rejected before the next convoy action', async () => {
  const client = app.client();
  await app.signIn(client, 'google', { id: 'expiry-test', name: 'Expired' });
  const box = await connected(app.socket(client));
  const { db } = await import('../src/db.js');
  db.handle.prepare('DELETE FROM sessions WHERE user_id = ?').run(box.all[0].me);
  box.send({ t: 'convoy.create', name: 'Must not create' });
  assert.equal(await box.closed, 4401);
  assert.equal(box.all.some((m) => m.t === 'room'), false);
});
