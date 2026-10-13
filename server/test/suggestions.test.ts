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
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
await app.signIn(mod, 'google', { id: '701', name: 'Moddy' });
const modId = (await mod('GET', '/api/auth/status')).json.user.id;
const aliceId = (await alice('GET', '/api/auth/status')).json.user.id;
await admin('PATCH', `/api/users/${modId}`, { role: 'moderator' });

const suggest = (extra: Record<string, unknown> = {}) => ({ name: 'Old quarry', notes: 'Sunset over the pit', lat: -33.42, lng: 149.58, ...extra });

test('suggesting a spot needs a sign-in, and the input is checked', async () => {
  assert.equal((await anon('POST', '/api/suggestions', suggest())).status, 401);
  for (const bad of [
    suggest({ name: '' }), suggest({ name: '   ' }), suggest({ name: 'x'.repeat(121) }), suggest({ notes: 'x'.repeat(1001) }),
    suggest({ lat: 91 }), suggest({ lng: -181 }), suggest({ lat: '12' }), suggest({ lat: undefined }), { name: 'No place' },
  ]) {
    assert.equal((await alice('POST', '/api/suggestions', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await alice('GET', '/api/suggestions')).status, 403, 'and the queue is not for contributors');
  assert.equal((await anon('GET', '/api/suggestions')).status, 401);
});

test('a suggestion waits in the queue and is not a spot until a moderator approves it', async () => {
  const made = await alice('POST', '/api/suggestions', suggest({ name: '  Old quarry  ' }));
  assert.equal(made.status, 201);
  assert.equal(made.json.name, 'Old quarry', 'trimmed');
  assert.equal(made.json.outcome, null);

  const spots = async () => (await bob('GET', '/api/spots')).json.map((s: { name: string }) => s.name);
  assert.ok(!(await spots()).includes('Old quarry'));
  const queue = (await mod('GET', '/api/suggestions')).json;
  assert.equal(queue[0].id, made.json.id);
  assert.equal(queue[0].suggestedBy, 'Alice');

  assert.equal((await bob('POST', `/api/suggestions/${made.json.id}/resolve`, { action: 'approve' })).status, 403);
  assert.equal((await mod('POST', `/api/suggestions/${made.json.id}/resolve`, { action: 'maybe' })).status, 400);
  const approved = await mod('POST', `/api/suggestions/${made.json.id}/resolve`, { action: 'approve' });
  assert.equal(approved.status, 200);

  const spot = (await anon('GET', `/api/spots/${approved.json.spotId}`)).json;
  assert.equal(spot.name, 'Old quarry');
  assert.equal(spot.visibility, 'public', 'a visitor can read it');
  assert.equal(spot.ownerId, aliceId);
  assert.ok((await spots()).includes('Old quarry'));
  assert.equal((await mod('POST', `/api/suggestions/${made.json.id}/resolve`, { action: 'reject' })).status, 409, 'settled once');
  assert.equal((await mod('POST', '/api/suggestions/nope/resolve', { action: 'reject' })).status, 404);
});

test('a rejected suggestion never becomes a spot', async () => {
  const made = await bob('POST', '/api/suggestions', suggest({ name: 'Somebody\'s garden' }));
  assert.equal((await admin('POST', `/api/suggestions/${made.json.id}/resolve`, { action: 'reject' })).json.spotId, null);
  const spots = (await anon('GET', '/api/spots')).json.map((s: { name: string }) => s.name);
  assert.ok(!spots.includes('Somebody\'s garden'));
  const settled = (await mod('GET', '/api/suggestions')).json.find((s: { id: string }) => s.id === made.json.id);
  assert.equal(settled.outcome, 'rejected');
});

test('one account cannot flood the queue', async () => {
  const carol = app.client();
  await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
  for (let i = 0; i < 10; i++) assert.equal((await carol('POST', '/api/suggestions', suggest({ name: `Spot ${i}` }))).status, 201);
  const refused = await carol('POST', '/api/suggestions', suggest({ name: 'One too many' }));
  assert.equal(refused.status, 429);
  assert.match(refused.json.error, /10 spots a day/);
});
