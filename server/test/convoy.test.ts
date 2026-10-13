import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LENGTH, CODE_PATTERN, MAX_MEMBERS, MAX_ROOMS_PER_USER, MEMBER_GRACE_MS, MissLimiter, newCode, normalizeCode, POSITION_GAP_MS, ROOM_IDLE_MS, Rooms,
} from '../src/convoy.js';
import { parseClientMessage } from '../src/wsMessages.js';

const who = (n: number) => ({ id: `u${n}`, username: `user${n}`, avatar: '' });
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };

test('codes are 8 characters with no lookalikes, and do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = newCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, CODE_PATTERN);
    assert.doesNotMatch(code, /[01OIL]/);
    seen.add(code);
  }
  assert.equal(seen.size, 2000);
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
});

test('the creator leads; joining twice is harmless; a stranger cannot set the destination', () => {
  const rooms = new Rooms();
  const made = rooms.create(who(1), { name: '  Sunday run  ' });
  assert.ok(made.ok);
  const room = made.value;
  assert.equal(room.name, 'Sunday run');
  assert.equal(room.leader, 'u1');
  assert.ok(rooms.join(room.code, who(2)).ok);
  assert.ok(rooms.join(room.code, who(2)).ok);
  assert.equal(rooms.view(room.code)!.members.length, 2);
  assert.equal(rooms.setDestination(room.code, 'u2', { lat: 1, lng: 2, label: 'x' }).ok, false);
  const set = rooms.setDestination(room.code, 'u1', { lat: 1, lng: 2, label: ' Lookout ' });
  assert.ok(set.ok);
  assert.equal(set.value.destination?.label, 'Lookout');
  assert.equal(rooms.handOver(room.code, 'u2', 'u1').ok, false, 'only the leader hands over');
  assert.equal(rooms.handOver(room.code, 'u1', 'nobody').ok, false);
  assert.equal(rooms.handOver(room.code, 'u1', 'u2').ok && rooms.view(room.code)!.leader, 'u2');
});

test('a convoy holds 30, and a user is in 3', () => {
  const rooms = new Rooms();
  const code = (rooms.create(who(0)) as { ok: true; value: { code: string } }).value.code;
  for (let i = 1; i < MAX_MEMBERS; i++) assert.ok(rooms.join(code, who(i)).ok, `member ${i + 1}`);
  const over = rooms.join(code, who(99));
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /full/);

  const mine = new Rooms();
  for (let i = 0; i < MAX_ROOMS_PER_USER; i++) assert.ok(mine.create(who(1)).ok);
  assert.equal(mine.create(who(1)).ok, false);
  const other = (mine.create(who(2)) as { ok: true; value: { code: string } }).value.code;
  assert.equal(mine.join(other, who(1)).ok, false, 'joining counts too');
});

test('positions are throttled to about one a second, and only the latest is kept', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  const p = { lat: -33, lng: 151, heading: 90, speed: 12 };
  assert.ok(rooms.position('u1', p));
  c.t += 100;
  assert.equal(rooms.position('u1', { ...p, lat: -34 }), null, 'too soon');
  c.t += POSITION_GAP_MS;
  assert.ok(rooms.position('u1', { ...p, lat: -35 }));
  assert.equal(rooms.view(code)!.members.find((m) => m.id === 'u1')!.position?.lat, -35);
  assert.equal(rooms.position('stranger', p), null, 'not in a room');
});

test('going offline clears the position and keeps the member; leaving removes them and passes the lead on', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  rooms.join(code, who(3));
  rooms.position('u2', { lat: 1, lng: 1, heading: null, speed: null });
  assert.deepEqual(rooms.setOnline('u2', false), [code]);
  const away = rooms.view(code)!.members.find((m) => m.id === 'u2')!;
  assert.equal(away.online, false);
  assert.equal(away.position, null);
  assert.equal(away.lastSeen, c.t);

  rooms.setOnline('u1', false);
  rooms.leave(code, 'u1');
  assert.equal(rooms.view(code)!.leader, 'u3', 'the lead goes to the longest-standing member who is connected');
  assert.equal(rooms.roomsOf('u1').length, 0);
  assert.equal(rooms.leave(code, 'u1'), undefined, 'leaving twice is nothing');
});

test('a room nobody is connected to expires, and a member who stays away too long goes', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const a = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  const b = (rooms.create(who(2), { eventId: 'ev1' }) as { ok: true; value: { code: string } }).value.code;
  rooms.join(b, who(3));
  assert.equal(rooms.forEvent('ev1'), b);

  rooms.setOnline('u1', false);
  rooms.setOnline('u2', false);
  c.t += ROOM_IDLE_MS - 1000;
  assert.deepEqual(rooms.sweep(), { changed: [], gone: [] });
  c.t += 2000;
  const swept = rooms.sweep();
  assert.deepEqual(swept.gone, [a]);
  assert.deepEqual(swept.changed, [b]);
  assert.equal(rooms.view(a), undefined, 'idle room is gone');
  // The other room still had u3 connected, so only u2 (away for the grace period) was let go.
  assert.ok(rooms.view(b));
  assert.deepEqual(rooms.view(b)!.members.map((m) => m.id), ['u3']);
  assert.equal(rooms.view(b)!.leader, 'u3');
  assert.ok(MEMBER_GRACE_MS <= ROOM_IDLE_MS);

  rooms.setOnline('u3', false);
  c.t += ROOM_IDLE_MS + 1;
  assert.ok(rooms.sweep().gone.includes(b));
  assert.equal(rooms.forEvent('ev1'), undefined, 'the cruise can have a new convoy');
});

test('a cruise has one convoy', () => {
  const rooms = new Rooms();
  assert.ok(rooms.create(who(1), { eventId: 'ev1' }).ok);
  assert.equal(rooms.create(who(2), { eventId: 'ev1' }).ok, false);
});

test('the leader can put someone out, and the code does not bring them back', () => {
  const rooms = new Rooms();
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  rooms.join(code, who(3));
  assert.equal(rooms.remove(code, 'u2', 'u3').ok, false, 'not the leader');
  assert.equal(rooms.remove(code, 'u1', 'u1').ok, false, 'not yourself');
  assert.equal(rooms.remove(code, 'u1', 'nobody').ok, false);
  const out = rooms.remove(code, 'u1', 'u2');
  assert.ok(out.ok);
  assert.deepEqual(rooms.view(code)!.members.map((m) => m.id), ['u1', 'u3']);
  const back = rooms.join(code, who(2));
  assert.equal(back.ok, false);
  assert.match((back as { error: string }).error, /removed you/);
  assert.equal(rooms.roomsOf('u2').length, 0);
});

test('removeUser takes someone out of every convoy', () => {
  const rooms = new Rooms();
  const a = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  const b = (rooms.create(who(2)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(a, who(3));
  rooms.join(b, who(3));
  assert.deepEqual(rooms.removeUser('u3').sort(), [a, b].sort());
  assert.equal(rooms.roomsOf('u3').length, 0);
});

test('wrong codes are counted per account and blocked after ten', () => {
  const c = clock();
  const limiter = new MissLimiter(c.now);
  for (let i = 0; i < 10; i++) { assert.equal(limiter.blocked('u1'), false); limiter.miss('u1'); }
  assert.equal(limiter.blocked('u1'), true);
  assert.equal(limiter.blocked('u2'), false);
  c.t += 10 * 60_000 + 1;
  assert.equal(limiter.blocked('u1'), false);
});

test('every client message is checked, and unlisted fields are dropped', () => {
  const ok = (m: unknown) => parseClientMessage(JSON.stringify(m));
  assert.deepEqual(ok({ t: 'pos', lat: 1, lng: 2, speed: 3, extra: 'x' }), { ok: true, message: { t: 'pos', lat: 1, lng: 2, heading: null, speed: 3 } });
  assert.deepEqual(ok({ t: 'convoy.join', code: 'abcd efgh' }), { ok: true, message: { t: 'convoy.join', code: 'ABCDEFGH' } });
  assert.deepEqual(ok({ t: 'convoy.dest', room: 'R', destination: null }), { ok: true, message: { t: 'convoy.dest', room: 'R', destination: null } });
  for (const bad of [
    'not json', '[]', '7', '{}', { t: 7 }, { t: 'nope' },
    { t: 'pos', lat: 91, lng: 0 }, { t: 'pos', lat: 0, lng: 181 }, { t: 'pos', lat: '1', lng: 0 }, { t: 'pos', lat: null, lng: 0 },
    { t: 'pos', lat: 0, lng: 0, speed: -1 }, { t: 'pos', lat: 0, lng: 0, speed: 1e6 }, { t: 'pos', lat: 0, lng: 0, heading: 361 },
    { t: 'pos', lat: Number.NaN, lng: 0 },
    { t: 'convoy.join', code: 'short' }, { t: 'convoy.join', code: 'ABCDEFG0' }, { t: 'convoy.join' },
    { t: 'convoy.create', name: 'x'.repeat(41) }, { t: 'convoy.create', name: 5 },
    { t: 'convoy.dest', room: 'R', destination: { lat: 0, lng: 0, label: 'x'.repeat(81) } }, { t: 'convoy.dest', room: 'R', destination: 'home' },
    { t: 'convoy.lead', room: 'R' }, { t: 'convoy.cruise', eventId: '' },
  ]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseClientMessage('{"t":"pos","lat":NaN}').ok, false);
});
