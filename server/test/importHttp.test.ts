import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp();
after(() => app.close());

const alice = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const spot = (props: Record<string, unknown>, coordinates: unknown = [149.5, -33.4]) =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { kind: 'spot', name: 'S', ...props } });

test('POST /api/import answers 400 with a message for a bad feature, and writes nothing', async () => {
  const r = await alice('POST', '/api/import', fc([spot({ name: 'ok' }), spot({}, [0, 99])]));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Feature 2/);
  assert.equal((await alice('GET', '/api/spots')).json.length, 0);
  const good = await alice('POST', '/api/import', fc([spot({ name: 'ok' })]));
  assert.deepEqual(good.json, { places: 0, spots: 1 });
});

test('POST /api/import refuses a bundle over the feature cap', async () => {
  const r = await alice('POST', '/api/import', fc(Array.from({ length: 2001 }, () => spot({}))));
  assert.equal(r.status, 400);
});

test('a body that is not JSON gets a fixed message, not the parser\'s', async () => {
  const r = await alice('POST', '/api/import', undefined, { 'Content-Type': 'application/json' });
  assert.equal(r.status, 400);
  const res = await fetch(`${app.base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: [...alice.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{"type": "Feat' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON' });
});
