import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp({ ADMIN_IDS: 'discord:900' });
const { eventSource } = await import('../src/events.js');
after(() => app.close());

const ev = (group: string, extra: Record<string, unknown> = {}) => ({
  group, title: `Event ${group}`, description: '', startTime: '2030-01-05T09:00:00.000Z', endTime: null, venueName: 'Venue', address: '',
  locality: '', lat: -33.4, lng: 149.5, imageUrl: '', images: [], category: '', priceText: '', isOnline: false, dateOnly: false, photoScore: 0,
  series: '', sources: [], hidden: false, culled: null, ...extra,
});
eventSource.read = () => [ev('one'), ev('two'), ev('gone', { hidden: true })];

const anon = app.client();
const alice = app.client();
const bob = app.client();
const admin = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bobby' });
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });
const bobId = (await bob('GET', '/api/auth/status')).json.user.id;

const tokenOf = (url: string): string => url.split('/').pop()!.replace('.ics', '');
const feed = (token: string, query = '') => anon('GET', `/api/calendar/${token}.ics${query}`);

test('the link needs a sign-in, shows its token once, and the feed lists events for whoever holds it', async () => {
  assert.equal((await anon('POST', '/api/calendar-link')).status, 401);
  assert.equal((await anon('GET', '/api/calendar-link')).status, 401);
  assert.deepEqual((await alice('GET', '/api/calendar-link')).json, { exists: false, createdAt: null });

  const made = await alice('POST', '/api/calendar-link');
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^[0-9a-f]{64}$/);
  assert.equal(made.json.url, `https://photoscout.test/api/calendar/${made.json.token}.ics`);
  const status = await alice('GET', '/api/calendar-link');
  assert.equal(status.json.exists, true);
  assert.ok(!status.text.includes(made.json.token), 'the token cannot be read back');

  const res = await feed(made.json.token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/calendar/);
  assert.match(res.text, /SUMMARY:Event one/);
  assert.ok(!res.text.includes('Event gone'), 'what the engine hides stays hidden');
});

test('a wrong token is a 404, whatever shape it has', async () => {
  for (const wrong of ['0'.repeat(64), 'f'.repeat(64), 'abc', 'x'.repeat(64), '%2e%2e']) {
    assert.equal((await anon('GET', `/api/calendar/${wrong}.ics`)).status, 404, wrong);
  }
  assert.equal((await anon('GET', '/api/calendar/nothing')).status, 404);
});

test('a new link ends the old one; deleting it ends them all', async () => {
  const first = tokenOf((await alice('POST', '/api/calendar-link')).json.url);
  const second = tokenOf((await alice('POST', '/api/calendar-link')).json.url);
  assert.notEqual(first, second);
  assert.equal((await feed(first)).status, 404, 'the old one stopped working');
  assert.equal((await feed(second)).status, 200);
  assert.equal((await alice('DELETE', '/api/calendar-link')).status, 200);
  assert.equal((await feed(second)).status, 404);
  assert.equal((await alice('GET', '/api/calendar-link')).json.exists, false);
});

test('your own stars narrow it and your own hides are left out', async () => {
  await bob('PUT', '/api/events/one/state', { starred: true });
  await bob('PUT', '/api/events/two/state', { hidden: true });
  const token = tokenOf((await bob('POST', '/api/calendar-link')).json.url);
  const all = (await feed(token)).text;
  assert.ok(all.includes('Event one') && !all.includes('Event two'));
  await bob('PUT', '/api/events/two/state', { hidden: false, starred: false });
  const shortlist = (await feed(token, '?starred=1')).text;
  assert.ok(shortlist.includes('Event one') && !shortlist.includes('Event two'));
});

test('suspending someone ends their link for good', async () => {
  const token = tokenOf((await bob('POST', '/api/calendar-link')).json.url);
  assert.equal((await feed(token)).status, 200);
  assert.equal((await admin('PATCH', `/api/users/${bobId}`, { banned: true })).status, 200);
  assert.equal((await feed(token)).status, 404);
  await admin('PATCH', `/api/users/${bobId}`, { banned: false });
  assert.equal((await feed(token)).status, 404, 'reinstating does not bring it back');
});
