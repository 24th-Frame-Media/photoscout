import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
const mod = app.client();
const carol = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
await app.signIn(mod, 'google', { id: '701', name: 'Moddy' });
await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
const idOf = async (c: typeof alice): Promise<string> => (await c('GET', '/api/auth/status')).json.user.id;
const [aliceId, modId] = await Promise.all([idOf(alice), idOf(mod)]);
await admin('PATCH', `/api/users/${modId}`, { role: 'moderator' });

const spot = (c: typeof alice, visibility: string, name = 'Lookout') => c('POST', '/api/spots', { name, lat: -33.4, lng: 149.5, visibility }).then((r) => r.json.id as string);
const place = (c: typeof alice, visibility: string) => c('POST', '/api/places', { name: 'Hill', lat: -33.4, lng: 149.5, visibility }).then((r) => r.json.id as string);

test('a suspended user\'s public spots and places leave the lists, and come back on reinstatement', async () => {
  const s = await spot(alice, 'public');
  const p = await place(alice, 'public');
  assert.ok((await anon('GET', '/api/spots')).json.some((x: any) => x.id === s));
  assert.equal((await mod('PATCH', `/api/users/${aliceId}`, { banned: true })).status, 200);
  for (const c of [anon, bob]) {
    assert.ok(!(await c('GET', '/api/spots')).json.some((x: any) => x.id === s), 'spot hidden');
    assert.ok(!(await c('GET', '/api/places')).json.some((x: any) => x.id === p), 'place hidden');
  }
  await mod('PATCH', `/api/users/${aliceId}`, { banned: false });
  assert.ok((await anon('GET', '/api/spots')).json.some((x: any) => x.id === s));
});

test('a moderator can delete a public spot or place, but not a private one, and a contributor still cannot', async () => {
  const pub = await spot(carol, 'public');
  const priv = await spot(carol, 'private');
  const unlisted = await spot(carol, 'unlisted');
  assert.equal((await bob('DELETE', `/api/spots/${pub}`)).status, 403);
  assert.equal((await mod('DELETE', `/api/spots/${priv}`)).status, 403);
  assert.equal((await mod('DELETE', `/api/spots/${pub}`)).status, 200);
  assert.equal((await mod('DELETE', `/api/spots/${unlisted}`)).status, 200);
  assert.equal((await anon('GET', `/api/spots/${pub}`)).status, 404);
  const pPub = await place(carol, 'public');
  const pPriv = await place(carol, 'private');
  assert.equal((await bob('DELETE', `/api/places/${pPub}`)).status, 403);
  assert.equal((await mod('DELETE', `/api/places/${pPriv}`)).status, 403);
  assert.equal((await mod('DELETE', `/api/places/${pPub}`)).status, 200);
});
