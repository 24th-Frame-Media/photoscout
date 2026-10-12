import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const app = await startApp();
after(() => app.close());

test('http: version is open, everything else needs a session in private mode', async () => {
  const anon = app.client();
  assert.equal((await anon('GET', '/api/version')).status, 200);
  assert.equal((await anon('GET', '/api/spots')).status, 401);
  assert.equal((await anon('POST', '/api/spots', { name: 'x', lat: 0, lng: 0 })).status, 401);
});

test('http: first-run setup signs the admin in, and logout signs them out', async () => {
  const admin = app.client();
  const setup = await admin('POST', '/api/auth/setup', { username: 'admin', password: 'correct horse battery' });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.user.role, 'admin');
  assert.equal((await admin('GET', '/api/spots')).status, 200);
  const missing = await admin('GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /Unknown endpoint/);
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'b', password: 'correct horse battery' })).status, 409);
  await admin('POST', '/api/auth/logout');
  assert.equal((await admin('GET', '/api/spots')).status, 401);
});
