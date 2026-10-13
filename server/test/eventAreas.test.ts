import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

/** What the crawler was last sent at PUT /config: every one, oldest first. */
const configs: { interests: { city: string; terms: string[] }[]; seeds: string[] }[] = [];

const app = await startApp({ ADMIN_IDS: 'discord:900', CRAWLER_URL: 'http://crawler.test:3002' });
after(() => app.close());

// Stub the crawler. The app's own port is local, so everything else goes through.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://crawler.test:3002/config')) {
    configs.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};

const admin = app.client();
await app.signIn(admin, 'discord', { id: '900', name: 'Rootuser' });

const area = (name: string, lat: number, lng: number, radiusKm: number, events = true, busy = false) =>
  ({ name, lat, lng, radiusKm, events, busy });

/** Wait for the fire-and-forget crawler sync that a save starts. */
async function lastConfig(count: number) {
  for (let i = 0; i < 100 && configs.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(configs.length >= count, 'the crawler was told');
  return configs[configs.length - 1];
}

test('saving areas hands them to the events engine and the crawler, switches and all', async () => {
  const put = await admin('PUT', '/api/settings', {
    home: area('Bathurst', -33.419, 149.577, 100, true, true),
    areas: [area('Orange', -33.284, 149.101, 30), area('Penrith', -33.751, 150.694, 25, false), area('Lithgow', -33.48, 150.16, 40, true, true)],
  });
  assert.equal(put.status, 200);

  const engine = (await admin('GET', '/api/events-admin/settings')).json;
  assert.equal(engine.city, 'Bathurst', 'home is the first area');
  assert.equal(engine.lat, -33.419);
  assert.equal(engine.radiusKm, 100);
  assert.deepEqual(engine.eventAreas.map((a: { name: string }) => a.name), ['Orange', 'Lithgow'], 'events off keeps Penrith out');
  assert.equal(engine.eventAreas[0].radiusKm, 30);
  assert.deepEqual(engine.densityAreas.map((a: { name: string }) => a.name), ['Bathurst', 'Lithgow'], 'only the busy ones');
  assert.equal(engine.densityAreas[0].radiusKm, 10, 'a busy sample is a town, not the 100 km that events reach');
  assert.equal(engine.densityAreas[1].radiusKm, 10);

  const sent = await lastConfig(1);
  assert.deepEqual(sent.interests.map((i) => i.city), ['Bathurst', 'Orange', 'Lithgow'], 'the crawler searches the events areas');
});

test('turning events off on home moves the engine onto the next area, and busy off empties the density list', async () => {
  const before = configs.length;
  await admin('PUT', '/api/settings', {
    home: area('Bathurst', -33.419, 149.577, 100, false, false),
    areas: [area('Orange', -33.284, 149.101, 30)],
  });
  const engine = (await admin('GET', '/api/events-admin/settings')).json;
  assert.equal(engine.city, 'Orange');
  assert.deepEqual(engine.eventAreas, []);
  assert.deepEqual(engine.densityAreas, []);
  assert.equal(engine.areasManaged, true);
  const sent = await lastConfig(before + 1);
  assert.deepEqual(sent.interests.map((i) => i.city), ['Orange']);
});

test('the events settings route no longer takes areas: the list is PhotoScout\'s', async () => {
  const put = await admin('PUT', '/api/events-admin/settings', {
    city: 'Elsewhere', lat: 1, lng: 2, radiusKm: 3, eventAreas: [{ name: 'Nowhere' }], densityAreas: [{ name: 'Nowhere' }],
    eventTopics: ['motorsport'],
  });
  assert.equal(put.status, 200);
  const engine = (await admin('GET', '/api/events-admin/settings')).json;
  assert.equal(engine.city, 'Orange');
  assert.deepEqual(engine.eventAreas, []);
  assert.deepEqual(engine.eventTopics, ['motorsport'], 'everything else is still saved');
});

test('areas written before the switches existed read back as events on, busy off', async () => {
  const { db } = await import('../src/db.js');
  db.setKv('settings', JSON.stringify({ home: { name: 'Old', lat: 1, lng: 2, radiusKm: 5 }, areas: [{ name: 'Older', lat: 3, lng: 4, radiusKm: 6 }] }));
  const got = (await admin('GET', '/api/settings')).json;
  assert.deepEqual([got.home.events, got.home.busy, got.areas[0].events, got.areas[0].busy], [true, false, true, false]);
});
