import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type Client } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
async function upload(as: Client | null, rideId: string, bytes: Buffer = PNG) {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(bytes)]), 'a.png');
  const cookie = as?.jar.get('__Host-ps_session');
  return fetch(`${app.base}/api/kit/rides/${rideId}/photos`, { method: 'POST', headers: cookie ? { Cookie: `__Host-ps_session=${cookie}` } : {}, body: form });
}

const car = { kind: 'car', make: 'Porsche', model: '911 GT3', year: 2023, nickname: 'Gwen', notes: 'Track car' };

test('rides: create, read on the profile, edit, delete', async () => {
  const made = await alice('POST', '/api/kit/rides', car);
  assert.equal(made.status, 201);
  assert.equal(made.json.make, 'Porsche');
  assert.deepEqual(made.json.photos, []);
  const profile = (await anon('GET', '/api/profiles/Alice')).json;
  assert.deepEqual(profile.rides.map((r: { id: string }) => r.id), [made.json.id]);
  const edited = await alice('PATCH', `/api/kit/rides/${made.json.id}`, { nickname: 'Greta', year: null });
  assert.equal(edited.json.nickname, 'Greta');
  assert.equal(edited.json.year, null);
  assert.equal(edited.json.make, 'Porsche', 'fields left out are kept');
  assert.equal((await alice('DELETE', `/api/kit/rides/${made.json.id}`)).status, 200);
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.rides.length, 0);
  assert.equal((await alice('DELETE', `/api/kit/rides/${made.json.id}`)).status, 404);
});

test('rides: every field is checked', async () => {
  const bad = async (body: unknown, why: string) => assert.equal((await alice('POST', '/api/kit/rides', body)).status, 400, why);
  await bad({ ...car, kind: 'boat' }, 'unknown kind');
  await bad({ ...car, kind: undefined }, 'no kind');
  await bad({ ...car, make: '' }, 'empty make');
  await bad({ ...car, make: '   ' }, 'blank make');
  await bad({ ...car, model: 'x'.repeat(61) }, 'model too long');
  await bad({ ...car, make: 5 }, 'make not text');
  await bad({ ...car, nickname: 'x'.repeat(61) }, 'nickname too long');
  await bad({ ...car, notes: 'x'.repeat(2001) }, 'notes too long');
  await bad({ ...car, year: 1885 }, 'before the first car');
  await bad({ ...car, year: new Date().getFullYear() + 2 }, 'too far ahead');
  await bad({ ...car, year: 1999.5 }, 'not whole');
  await bad({ ...car, year: '2020' }, 'not a number');
  await bad([car], 'not an object');
  assert.equal((await alice('POST', '/api/kit/rides', { ...car, year: 1886, notes: 'x'.repeat(2000) })).status, 201, 'the edges');
  assert.equal((await alice('POST', '/api/kit/rides', { kind: 'motorbike', make: 'Ducati', model: 'Panigale', year: new Date().getFullYear() + 1 })).status, 201);
  const id = (await alice('POST', '/api/kit/rides', car)).json.id;
  assert.equal((await alice('PATCH', `/api/kit/rides/${id}`, { kind: 'plane' })).status, 400);
  assert.equal((await alice('PATCH', `/api/kit/rides/${id}`, { make: '' })).status, 400);
  assert.equal((await alice('GET', '/api/profiles/Alice')).json.rides.find((r: { id: string }) => r.id === id).kind, 'car', 'a refused edit changed nothing');
});

test('rides: only the owner or an admin may change one; a visitor is turned away', async () => {
  const id = (await alice('POST', '/api/kit/rides', car)).json.id;
  assert.equal((await anon('POST', '/api/kit/rides', car)).status, 401);
  assert.equal((await anon('PATCH', `/api/kit/rides/${id}`, { make: 'x' })).status, 401);
  assert.equal((await anon('DELETE', `/api/kit/rides/${id}`)).status, 401);
  assert.equal((await bob('PATCH', `/api/kit/rides/${id}`, { make: 'Hacked' })).status, 403);
  assert.equal((await bob('DELETE', `/api/kit/rides/${id}`)).status, 403);
  assert.equal((await bob('PATCH', '/api/kit/rides/nope', { make: 'x' })).status, 404);
  assert.equal((await bob('POST', `/api/kit/rides/${id}/photos`, {})).status, 403);
  assert.equal((await alice('GET', '/api/profiles/Alice')).json.rides.find((r: { id: string }) => r.id === id).make, 'Porsche');
  assert.equal((await admin('PATCH', `/api/kit/rides/${id}`, { nickname: 'Moderated' })).json.nickname, 'Moderated');
  assert.equal((await admin('DELETE', `/api/kit/rides/${id}`)).status, 200);
});

test('rides: capped at 30 per person', async () => {
  const carol = app.client();
  await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
  for (let i = 0; i < 30; i++) assert.equal((await carol('POST', '/api/kit/rides', { ...car, model: `Car ${i}` })).status, 201);
  const over = await carol('POST', '/api/kit/rides', car);
  assert.equal(over.status, 409);
  assert.match(over.json.error, /30/);
  assert.equal((await alice('POST', '/api/kit/rides', car)).status, 201, 'the cap is per person');
});

test('ride photos: magic bytes, six at most, public to read, owner only to change', async () => {
  const id = (await bob('POST', '/api/kit/rides', car)).json.id;
  assert.equal((await upload(null, id)).status, 401);
  assert.equal((await upload(alice, id)).status, 403);
  assert.equal((await upload(bob, id, Buffer.from('<script>alert(1)</script>'.padEnd(40)))).status, 400, 'not an image');
  assert.equal((await upload(bob, id, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]))).status, 400, 'a GIF is not on the list');
  assert.equal((await upload(bob, 'nope')).status, 404);
  let last: any;
  for (let i = 0; i < 6; i++) {
    const r = await upload(bob, id);
    assert.equal(r.status, 201);
    last = await r.json();
  }
  assert.equal(last.photos.length, 6);
  assert.equal((await upload(bob, id)).status, 409, 'a seventh');

  const photo = last.photos[0];
  const file = await anon('GET', photo.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal((await anon('GET', photo.thumbUrl)).status, 200);
  assert.equal((await anon('GET', '/api/kit/photos/nope/file')).status, 404);
  assert.equal((await anon('GET', '/api/kit/photos/..%2F..%2Fphotoscout.db/file')).status, 404);

  assert.equal((await anon('DELETE', `/api/kit/photos/${photo.id}`)).status, 401);
  assert.equal((await alice('DELETE', `/api/kit/photos/${photo.id}`)).status, 403);
  assert.equal((await bob('DELETE', `/api/kit/photos/${photo.id}`)).status, 200);
  assert.equal((await anon('GET', photo.url)).status, 404);
  assert.equal((await upload(bob, id)).status, 201, 'room again');
  assert.equal((await admin('DELETE', `/api/kit/photos/${last.photos[1].id}`)).status, 200);
});

test('ride photos of a suspended account are not served', async () => {
  const erin = app.client();
  await app.signIn(erin, 'google', { id: '555', name: 'Erin' });
  const id = (await erin('POST', '/api/kit/rides', car)).json.id;
  const photo = ((await (await upload(erin, id)).json()) as { photos: { url: string }[] }).photos[0];
  assert.equal((await anon('GET', photo.url)).status, 200);
  const erinId = (await erin('GET', '/api/auth/status')).json.user.id;
  await admin('PATCH', `/api/users/${erinId}`, { banned: true });
  assert.equal((await anon('GET', photo.url)).status, 404);
  assert.equal((await upload(erin, id)).status, 401, 'and she cannot add more');
  await admin('PATCH', `/api/users/${erinId}`, { banned: false });
});

test('gear: create, edit, delete, validation, ownership', async () => {
  const gear = { kind: 'lens', brand: 'Sigma', name: '150-600mm f/5-6.3', notes: 'Panning' };
  const made = await alice('POST', '/api/kit/gear', gear);
  assert.equal(made.status, 201);
  assert.equal((await anon('GET', '/api/profiles/Alice')).json.gear.some((g: { id: string }) => g.id === made.json.id), true);
  assert.equal((await alice('PATCH', `/api/kit/gear/${made.json.id}`, { notes: 'Rolling shots' })).json.notes, 'Rolling shots');

  const bad = async (body: unknown, why: string) => assert.equal((await alice('POST', '/api/kit/gear', body)).status, 400, why);
  await bad({ ...gear, kind: 'tripod' }, 'unknown kind');
  await bad({ ...gear, brand: '' }, 'no brand');
  await bad({ ...gear, name: 'x'.repeat(101) }, 'name too long');
  await bad({ ...gear, brand: 'x'.repeat(61) }, 'brand too long');
  await bad({ ...gear, notes: 'x'.repeat(501) }, 'notes too long');
  await bad({ ...gear, name: 12 }, 'name not text');
  assert.equal((await alice('PATCH', `/api/kit/gear/${made.json.id}`, { kind: 'bag' })).status, 400);

  assert.equal((await anon('POST', '/api/kit/gear', gear)).status, 401);
  assert.equal((await anon('PATCH', `/api/kit/gear/${made.json.id}`, { notes: 'x' })).status, 401);
  assert.equal((await anon('DELETE', `/api/kit/gear/${made.json.id}`)).status, 401);
  assert.equal((await bob('PATCH', `/api/kit/gear/${made.json.id}`, { notes: 'x' })).status, 403);
  assert.equal((await bob('DELETE', `/api/kit/gear/${made.json.id}`)).status, 403);
  assert.equal((await bob('DELETE', '/api/kit/gear/nope')).status, 404);
  assert.equal((await admin('PATCH', `/api/kit/gear/${made.json.id}`, { notes: 'Moderated' })).json.notes, 'Moderated');
  assert.equal((await alice('DELETE', `/api/kit/gear/${made.json.id}`)).status, 200);
  assert.equal((await alice('DELETE', `/api/kit/gear/${made.json.id}`)).status, 404);
});

test('gear: capped at 100 per person', async () => {
  const dave = app.client();
  await app.signIn(dave, 'google', { id: '444', name: 'Dave' });
  for (let i = 0; i < 100; i++) assert.equal((await dave('POST', '/api/kit/gear', { kind: 'other', brand: 'Generic', name: `Item ${i}` })).status, 201);
  const over = await dave('POST', '/api/kit/gear', { kind: 'other', brand: 'Generic', name: 'One more' });
  assert.equal(over.status, 409);
  assert.equal((await alice('POST', '/api/kit/gear', { kind: 'other', brand: 'Generic', name: 'Mine' })).status, 201);
});

test('the gear catalog needs a session, matches by prefix and returns at most 20', async () => {
  assert.equal((await anon('GET', '/api/gear/catalog?q=can')).status, 401);
  const canon = (await alice('GET', '/api/gear/catalog?q=canon')).json;
  assert.ok(canon.length > 0 && canon.length <= 20);
  for (const item of canon) {
    assert.deepEqual(Object.keys(item).sort(), ['brand', 'kind', 'name']);
    assert.ok(['camera', 'lens'].includes(item.kind));
    assert.match(`${item.brand} ${item.name}`, /^canon/i);
  }
  assert.deepEqual((await alice('GET', '/api/gear/catalog')).json, []);
  assert.deepEqual((await alice('GET', '/api/gear/catalog?q=zzzzzzzz')).json, []);
  assert.deepEqual((await alice('GET', '/api/gear/catalog?q[]=a')).json, []);
});

test('ride photos count toward the same daily cap as spot photos', async () => {
  // The cap itself is 200 and is read off the database, so fill it directly and ask the endpoint.
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const frank = app.client();
  await app.signIn(frank, 'google', { id: '666', name: 'Frank' });
  const frankId = (await frank('GET', '/api/auth/status')).json.user.id;
  const id = (await frank('POST', '/api/kit/rides', car)).json.id;
  const raw = new DatabaseSync(path.join(app.dataDir, 'photoscout.db'));
  const now = new Date().toISOString();
  const ins = raw.prepare("INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, created_at) VALUES (?, 's', ?, 'taken_here', 'f.png', 't.png', ?)");
  for (let i = 0; i < 200; i++) ins.run(`p${i}`, frankId, now);
  raw.close();
  const r = await upload(frank, id);
  assert.equal(r.status, 429);
});
