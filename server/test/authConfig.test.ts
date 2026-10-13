import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { authConfigView, configuredProviders, credentials, updateCredentials } from '../src/oauth.js';

const SECRET = 'discord-secret-from-the-ui';

function noEnv() {
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) delete process.env[k];
}

test('auth config: a saved pair turns a provider on, and the secret is never shown', () => {
  noEnv();
  const db = createDb(':memory:');
  assert.deepEqual(configuredProviders(db), []);
  assert.equal(updateCredentials(db, 'discord', { clientId: '1234567890', clientSecret: SECRET }), null);
  assert.deepEqual(configuredProviders(db), ['discord']);
  const view = authConfigView(db);
  assert.ok(!JSON.stringify(view).includes(SECRET));
  const d = view.providers.find((p) => p.name === 'discord')!;
  assert.equal(d.clientId, '1234567890');
  assert.equal(d.secretSet, true);
  assert.match(d.redirectUrl, /\/api\/auth\/discord\/callback$/);
});

test('auth config: a blank secret keeps the saved one; clear removes both; bad input is refused', () => {
  noEnv();
  const db = createDb(':memory:');
  assert.equal(updateCredentials(db, 'discord', { clientId: 'abc' }), 'A client secret is needed');
  updateCredentials(db, 'discord', { clientId: 'abc', clientSecret: SECRET });
  assert.equal(updateCredentials(db, 'discord', { clientId: 'def', clientSecret: '' }), null);
  assert.deepEqual(credentials(db, 'discord'), { id: 'def', secret: SECRET });
  assert.equal(updateCredentials(db, 'discord', { clientId: 'has space', clientSecret: 'x' }), 'That client id does not look right');
  assert.equal(updateCredentials(db, 'twitter', { clientId: 'a', clientSecret: 'b' }), 'No such sign-in');
  assert.equal(updateCredentials(db, 'discord', { clear: true }), null);
  assert.deepEqual(configuredProviders(db), []);
});

test('auth config: the environment wins and cannot be changed from the UI', () => {
  noEnv();
  process.env.DISCORD_CLIENT_ID = 'env-id';
  process.env.DISCORD_CLIENT_SECRET = 'env-secret';
  try {
    const db = createDb(':memory:');
    assert.match(updateCredentials(db, 'discord', { clientId: 'ui', clientSecret: 'ui' }) ?? '', /DISCORD_CLIENT_ID/);
    assert.deepEqual(credentials(db, 'discord'), { id: 'env-id', secret: 'env-secret' });
    assert.equal(authConfigView(db).providers.find((p) => p.name === 'discord')!.fromEnv, true);
  } finally { noEnv(); }
});
