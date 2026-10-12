import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

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

test('a profile is public by handle, and carries nothing private', async () => {
  const r = await anon('GET', '/api/profiles/alice');
  assert.equal(r.status, 200, 'handles are not case-sensitive');
  assert.deepEqual(Object.keys(r.json).sort(), ['avatar', 'bio', 'createdAt', 'followers', 'following', 'gear', 'id', 'instagram', 'isFollowing', 'rides', 'username']);
  assert.equal(r.json.username, 'Alice');
  assert.equal(r.json.isFollowing, false);
  assert.equal((await anon('GET', '/api/profiles/nobody')).status, 404);
  assert.equal((await anon('GET', '/api/profiles/a%20b')).status, 404);
  assert.equal((await anon('GET', '/api/profiles/ab')).status, 404, 'not a possible handle');
});

test('bio and Instagram are saved through PATCH /api/auth/me, handle only still works', async () => {
  const r = await alice('PATCH', '/api/auth/me', { bio: '  Shoots GT3 at Bathurst  ', instagram: '@alice.shoots_cars' });
  assert.equal(r.status, 200);
  assert.equal(r.json.bio, 'Shoots GT3 at Bathurst');
  assert.equal(r.json.instagram, 'alice.shoots_cars', 'stored without the @');
  const p = (await anon('GET', '/api/profiles/Alice')).json;
  assert.equal(p.bio, 'Shoots GT3 at Bathurst');
  assert.equal(p.instagram, 'alice.shoots_cars');
  // The handle alone leaves the rest.
  assert.equal((await alice('PATCH', '/api/auth/me', { username: 'Alice' })).json.bio, 'Shoots GT3 at Bathurst');
  // Empty clears it.
  assert.equal((await alice('PATCH', '/api/auth/me', { instagram: '' })).json.instagram, '');
  assert.equal((await alice('PATCH', '/api/auth/me', { instagram: 'alice.shoots_cars' })).json.instagram, 'alice.shoots_cars');
});

test('bio and Instagram are validated, and nothing is saved on a refusal', async () => {
  const bad = async (body: unknown, why: string) => {
    const r = await alice('PATCH', '/api/auth/me', body);
    assert.equal(r.status, 400, why);
  };
  await bad({ bio: 'x'.repeat(501) }, 'bio too long');
  await bad({ bio: 7 }, 'bio not text');
  await bad({ instagram: 'https://instagram.com/alice' }, 'a URL');
  await bad({ instagram: 'javascript:alert(1)' }, 'a scheme');
  await bad({ instagram: 'a b' }, 'a space');
  await bad({ instagram: 'a/b' }, 'a slash');
  await bad({ instagram: 'x'.repeat(31) }, 'too long');
  await bad({ instagram: '..' }, 'only dots');
  await bad({ instagram: 5 }, 'not text');
  await bad({}, 'nothing to change');
  await bad({ username: 'ok_name', bio: 'x'.repeat(501) }, 'a bad bio stops the handle too');
  assert.equal((await alice('GET', '/api/auth/status')).json.user.username, 'Alice');
  assert.equal((await alice('PATCH', '/api/auth/me', { bio: 'x'.repeat(500) })).status, 200, 'exactly the limit');
  assert.equal((await anon('PATCH', '/api/auth/me', { bio: 'hi' })).status, 401);
});

test('profile search needs a session, matches by prefix, and returns at most 20', async () => {
  assert.equal((await anon('GET', '/api/profiles?q=al')).status, 401);
  const found = (await bob('GET', '/api/profiles?q=al')).json;
  assert.deepEqual(found.map((u: { username: string }) => u.username), ['Alice']);
  assert.deepEqual(Object.keys(found[0]).sort(), ['avatar', 'username']);
  assert.deepEqual((await bob('GET', '/api/profiles?q=lice')).json, [], 'a prefix, not a substring');
  assert.deepEqual((await bob('GET', '/api/profiles?q=%25')).json, [], 'no wildcards');
  assert.deepEqual((await bob('GET', '/api/profiles?q=_')).json, [], 'an underscore is not a wildcard');
  assert.deepEqual((await bob('GET', '/api/profiles')).json, []);
  for (let i = 0; i < 25; i++) await app.signIn(app.client(), 'google', { id: `many${i}`, name: `Zed${String(i).padStart(2, '0')}` });
  assert.equal((await bob('GET', '/api/profiles?q=zed')).json.length, 20);
});

test('follow: sign-in required, idempotent, not yourself, listed back, counted', async () => {
  assert.equal((await anon('PUT', '/api/follows/Alice')).status, 401);
  assert.equal((await anon('DELETE', '/api/follows/Alice')).status, 401);
  assert.equal((await anon('GET', '/api/follows')).status, 401);
  assert.equal((await alice('PUT', '/api/follows/Alice')).status, 400, 'not yourself');
  assert.equal((await bob('PUT', '/api/follows/nobody')).status, 404);
  assert.equal((await bob('PUT', '/api/follows/Alice')).status, 200);
  assert.equal((await bob('PUT', '/api/follows/alice')).status, 200, 'twice is fine');
  assert.equal((await carol('PUT', '/api/follows/Alice')).status, 200);
  assert.deepEqual((await bob('GET', '/api/follows')).json.map((u: { username: string }) => u.username), ['Alice']);
  const seenByBob = (await bob('GET', '/api/profiles/Alice')).json;
  assert.equal(seenByBob.followers, 2);
  assert.equal(seenByBob.isFollowing, true);
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.isFollowing, false);
  assert.equal((await bob('GET', '/api/profiles/Bobby')).json.following, 1);
  assert.deepEqual((await bob('DELETE', '/api/follows/Alice')).json, { following: false });
  assert.equal((await bob('DELETE', '/api/follows/Alice')).status, 200, 'unfollowing twice is fine');
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.followers, 1);
  await carol('DELETE', '/api/follows/Alice');
});

test('a suspended account has no profile, cannot be followed, and falls out of searches and lists', async () => {
  const dave = app.client();
  await app.signIn(dave, 'google', { id: '444', name: 'Dave' });
  const daveId = await idOf(dave);
  assert.equal((await bob('PUT', '/api/follows/Dave')).status, 200);
  await admin('PATCH', `/api/users/${daveId}`, { banned: true });
  assert.equal((await anon('GET', '/api/profiles/Dave')).status, 404);
  assert.equal((await admin('GET', '/api/profiles/Dave')).status, 404, 'for an admin too');
  assert.equal((await carol('PUT', '/api/follows/Dave')).status, 404);
  assert.deepEqual((await bob('GET', '/api/profiles?q=dav')).json, []);
  assert.deepEqual((await bob('GET', '/api/follows')).json, []);
  assert.equal((await bob('DELETE', '/api/follows/Dave')).status, 200, 'a follow of a suspended account can be removed');
  await admin('PATCH', `/api/users/${daveId}`, { banned: false });
  assert.equal((await anon('GET', '/api/profiles/Dave')).status, 200);
});

test('deleting an account removes its kit, photo files, follows, events and RSVPs', async () => {
  const erin = app.client();
  await app.signIn(erin, 'google', { id: '555', name: 'Erin' });
  const erinId = await idOf(erin);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ride = (await erin('POST', '/api/kit/rides', { kind: 'car', make: 'Mazda', model: 'MX-5' })).json;
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'a.png');
  const up = await fetch(`${app.base}/api/kit/rides/${ride.id}/photos`, { method: 'POST', headers: { Cookie: `__Host-ps_session=${erin.jar.get('__Host-ps_session')}` }, body: form });
  assert.equal(up.status, 201);
  const photo = (await up.json() as { photos: { id: string }[] }).photos[0];
  const files = fs.readdirSync(path.join(app.dataDir, 'photos'));
  assert.equal(files.length, 2, 'a picture and its thumbnail');
  await erin('POST', '/api/kit/gear', { kind: 'lens', brand: 'Canon', name: '70-200mm f/2.8' });
  await erin('PUT', '/api/follows/Alice');
  await bob('PUT', '/api/follows/Erin');
  const when = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const mine = (await erin('POST', '/api/community-events', { title: 'Erin meet', startTime: when, lat: -33.8, lng: 151.2 })).json;
  const theirs = (await alice('POST', '/api/community-events', { title: 'Alice meet', startTime: when, lat: -33.8, lng: 151.2 })).json;
  assert.equal((await bob('PUT', `/api/community-events/${mine.id}/rsvp`)).json.going, 1);
  assert.equal((await erin('PUT', `/api/community-events/${theirs.id}/rsvp`)).json.going, 1);

  assert.equal((await admin('DELETE', `/api/users/${erinId}`)).status, 200);

  assert.equal((await anon('GET', '/api/profiles/Erin')).status, 404);
  assert.equal((await anon('GET', `/api/kit/photos/${photo.id}/file`)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(app.dataDir, 'photos')), [], 'the files are gone from disk');
  assert.equal((await anon('GET', `/api/community-events/${mine.id}`)).status, 404);
  assert.equal((await anon('GET', `/api/community-events/${theirs.id}`)).json.going, 0, 'their RSVP went with them');
  assert.deepEqual((await bob('GET', '/api/follows')).json, []);
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.followers, 0, 'and the people they followed lost the follower');
  // Nothing is left behind in any table.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(app.dataDir, 'photoscout.db'));
  for (const [table, column] of [['rides', 'owner_id'], ['ride_photos', 'owner_id'], ['gear', 'owner_id'], ['follows', 'follower_id'],
    ['follows', 'followee_id'], ['community_events', 'owner_id'], ['community_rsvps', 'user_id']]) {
    assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(erinId) as { n: number }).n, 0, `${table}.${column}`);
  }
  raw.close();
});
