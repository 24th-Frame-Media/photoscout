import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
const { db } = await import('../src/db.js');
after(() => app.close());

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

const MIN = 60_000;
const bodies = async (c: typeof alice, qs = ''): Promise<string[]> => (await c('GET', `/api/chat${qs}`)).json.map((m: { body: string }) => m.body);
/** A message written straight into the table, as if sent `minutesAgo` minutes ago. */
function planted(ownerId: string, body: string, minutesAgo: number): string {
  const id = `planted-${body}`;
  db.handle.prepare('INSERT INTO chat_messages (id, owner_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(id, ownerId, body, new Date(Date.now() - minutesAgo * MIN).toISOString());
  return id;
}

test('a visitor gets nothing: reading, writing and deleting chat all need a session', async () => {
  assert.equal((await anon('GET', '/api/chat')).status, 401);
  assert.equal((await anon('POST', '/api/chat', { body: 'hi' })).status, 401);
  assert.equal((await anon('DELETE', '/api/chat/x')).status, 401);
});

test('messages come back oldest first with only the listed fields, and `after` returns what is newer', async () => {
  const one = await alice('POST', '/api/chat', { body: 'first' });
  assert.equal(one.status, 201);
  assert.deepEqual(Object.keys(one.json).sort(), ['author', 'body', 'created_at', 'id']);
  assert.deepEqual(Object.keys(one.json.author).sort(), ['avatar', 'username']);
  await new Promise((r) => setTimeout(r, 5));
  await bob('POST', '/api/chat', { body: 'second' });
  assert.deepEqual(await bodies(bob), ['first', 'second']);
  assert.deepEqual(await bodies(alice, `?after=${encodeURIComponent(one.json.created_at)}`), ['second']);
  assert.equal((await alice('GET', '/api/chat?after=lunchtime')).status, 400);
});

test('a message is 1 to 300 characters', async () => {
  assert.equal((await alice('POST', '/api/chat', { body: 'x'.repeat(301) })).status, 400);
  assert.equal((await alice('POST', '/api/chat', { body: '   ' })).status, 400);
  assert.equal((await alice('POST', '/api/chat', {})).status, 400);
  assert.equal((await alice('POST', '/api/chat', { body: 7 })).status, 400);
  assert.equal((await alice('POST', '/api/chat', { body: 'x'.repeat(300) })).status, 201);
});

test('only the author or staff may delete a message', async () => {
  const msg = (await alice('POST', '/api/chat', { body: 'delete me' })).json;
  assert.equal((await bob('DELETE', `/api/chat/${msg.id}`)).status, 403);
  assert.equal((await alice('DELETE', `/api/chat/${msg.id}`)).status, 200);
  assert.equal((await alice('DELETE', `/api/chat/${msg.id}`)).status, 404);
  const other = (await bob('POST', '/api/chat', { body: 'admin removes' })).json;
  assert.equal((await admin('DELETE', `/api/chat/${other.id}`)).status, 200);
  assert.equal((await bodies(alice)).includes('admin removes'), false);
});

test('nothing older than 30 minutes is returned, even if the task has not run, and housekeeping then deletes it', async () => {
  const aliceId = (await alice('GET', '/api/auth/status')).json.user.id;
  planted(aliceId, 'stale', 31);
  planted(aliceId, 'recent', 29);
  const got = await bodies(bob);
  assert.equal(got.includes('stale'), false);
  assert.equal(got.includes('recent'), true);
  // Asking for a window that starts before the limit does not reach past it.
  assert.equal((await bodies(bob, `?after=${encodeURIComponent(new Date(Date.now() - 3 * 60 * MIN).toISOString())}`)).includes('stale'), false);

  const count = (body: string) => Number((db.handle.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE body = ?').get(body) as { n: number | bigint }).n);
  assert.equal(count('stale'), 1, 'still in the table until the task runs');
  assert.equal((await bob('POST', '/api/tasks/housekeeping/run')).status, 403, 'an ordinary account cannot run it');
  assert.equal((await admin('POST', '/api/tasks/housekeeping/run')).status, 200);
  assert.equal(count('stale'), 0);
  assert.equal(count('recent'), 1);
});

test('a suspended account\'s messages vanish, and return with it', async () => {
  const carol = app.client();
  await app.signIn(carol, 'google', { id: '333', name: 'Carol' });
  const carolId = (await carol('GET', '/api/auth/status')).json.user.id;
  await carol('POST', '/api/chat', { body: 'from carol' });
  assert.ok((await bodies(bob)).includes('from carol'));
  await admin('PATCH', `/api/users/${carolId}`, { banned: true });
  assert.equal((await bodies(bob)).includes('from carol'), false);
  await admin('PATCH', `/api/users/${carolId}`, { banned: false });
  assert.ok((await bodies(bob)).includes('from carol'));
});
