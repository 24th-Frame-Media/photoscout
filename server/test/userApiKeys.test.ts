import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'photoscout-keys-'));

const { createDb } = await import('../src/db.js');
const { getUserApiKey, setUserApiKey, clearUserApiKey, getUserApiKeyStatus } = await import('../src/userApiKeys.js');
const { startApp } = await import('./httpHarness.js');

const KEY_USER1 = 'test-secret-user1-tfnsw-key-abc';
const KEY_USER2 = 'test-secret-user2-tfnsw-key-xyz';
const OPENAIP_KEY1 = 'test-secret-user1-openaip-key-123';

test('user api keys: store isolates keys between two users and never leaks secrets in status', () => {
  const db = createDb(':memory:');
  const user1 = 'user-id-1';
  const user2 = 'user-id-2';

  // Seed users in memory db
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(user1, 'user1', 'g-1');
  db.handle.prepare("INSERT INTO users (id, username, provider, provider_id, created_at) VALUES (?, ?, 'google', ?, datetime('now'))")
    .run(user2, 'user2', 'g-2');

  // Initially neither user has keys
  const initial1 = getUserApiKeyStatus(db, user1);
  const initial2 = getUserApiKeyStatus(db, user2);
  assert.equal(initial1.tfnswKeySet, false);
  assert.equal(initial1.openaipKeySet, false);
  assert.equal(initial2.tfnswKeySet, false);
  assert.equal(initial2.openaipKeySet, false);

  // Set tfnsw key for user 1
  setUserApiKey(db, user1, 'tfnsw', KEY_USER1);
  assert.equal(getUserApiKey(db, user1, 'tfnsw'), KEY_USER1);
  assert.equal(getUserApiKey(db, user2, 'tfnsw'), null, 'user2 must not see user1 key');

  const status1 = getUserApiKeyStatus(db, user1);
  const status2 = getUserApiKeyStatus(db, user2);
  assert.equal(status1.tfnswKeySet, true);
  assert.equal(status1.openaipKeySet, false);
  assert.equal(status2.tfnswKeySet, false, 'user2 status must remain false');
  assert.ok(!JSON.stringify(status1).includes(KEY_USER1), 'secret leaked into status output');

  // Set different key for user 2
  setUserApiKey(db, user2, 'tfnsw', KEY_USER2);
  assert.equal(getUserApiKey(db, user1, 'tfnsw'), KEY_USER1);
  assert.equal(getUserApiKey(db, user2, 'tfnsw'), KEY_USER2);
  assert.equal(getUserApiKeyStatus(db, user1).tfnswKeySet, true);
  assert.equal(getUserApiKeyStatus(db, user2).tfnswKeySet, true);

  // Set openaip key for user 1
  setUserApiKey(db, user1, 'openaip', OPENAIP_KEY1);
  assert.equal(getUserApiKey(db, user1, 'openaip'), OPENAIP_KEY1);
  assert.equal(getUserApiKey(db, user2, 'openaip'), null);
  assert.equal(getUserApiKeyStatus(db, user1).openaipKeySet, true);
  assert.equal(getUserApiKeyStatus(db, user2).openaipKeySet, false);

  // Clear user 1 tfnsw key
  clearUserApiKey(db, user1, 'tfnsw');
  assert.equal(getUserApiKey(db, user1, 'tfnsw'), null);
  assert.equal(getUserApiKey(db, user2, 'tfnsw'), KEY_USER2, 'user2 key untouched');
  assert.equal(getUserApiKeyStatus(db, user1).tfnswKeySet, false);
  assert.equal(getUserApiKeyStatus(db, user1).openaipKeySet, true);
  assert.equal(getUserApiKeyStatus(db, user2).tfnswKeySet, true);
});

test('user api keys over HTTP: authenticated endpoints isolate users, non-admins can manage keys, no secrets leaked', async () => {
  const h = await startApp({ ADMIN_IDS: 'google:admin1' });
  try {
    const anon = h.client();
    const user1 = h.client();
    const user2 = h.client();

    await h.signIn(user1, 'google', { id: 'u1', name: 'UserOne' });
    await h.signIn(user2, 'google', { id: 'u2', name: 'UserTwo' });

    // Anonymous requests are rejected
    assert.equal((await anon('GET', '/api/user/api-keys')).status, 401);
    assert.equal((await anon('PUT', '/api/user/api-keys/tfnsw', { apiKey: KEY_USER1 })).status, 401);

    // Initial status for user1
    const res1 = await user1('GET', '/api/user/api-keys');
    assert.equal(res1.status, 200);
    assert.equal(res1.json.tfnswKeySet, false);
    assert.equal(res1.json.openaipKeySet, false);

    // Non-admin user can save key
    const put1 = await user1('PUT', '/api/user/api-keys/tfnsw', { apiKey: KEY_USER1 });
    assert.equal(put1.status, 200);
    assert.equal(put1.json.tfnswKeySet, true);
    assert.ok(!put1.text.includes(KEY_USER1), 'secret leaked in PUT response');

    // User 1 cannot modify instance settings (admin only)
    assert.equal((await user1('PUT', '/api/settings', { allowPrivateRemotes: true })).status, 403);

    // User 2 status is still false (isolation)
    const res2 = await user2('GET', '/api/user/api-keys');
    assert.equal(res2.status, 200);
    assert.equal(res2.json.tfnswKeySet, false);
    assert.ok(!res2.text.includes(KEY_USER1), 'user1 secret leaked to user2');

    // User 2 sets their own key
    const put2 = await user2('PUT', '/api/user/api-keys/tfnsw', { apiKey: KEY_USER2 });
    assert.equal(put2.status, 200);
    assert.equal(put2.json.tfnswKeySet, true);
    assert.ok(!put2.text.includes(KEY_USER2), 'secret leaked in PUT response');

    // User 1 sets openaip key
    const putOpenAip = await user1('PUT', '/api/user/api-keys/openaip', { apiKey: OPENAIP_KEY1 });
    assert.equal(putOpenAip.status, 200);
    assert.equal(putOpenAip.json.openaipKeySet, true);
    assert.ok(!putOpenAip.text.includes(OPENAIP_KEY1), 'openaip secret leaked');

    // User 2 openaip is still false
    const res2After = await user2('GET', '/api/user/api-keys');
    assert.equal(res2After.json.openaipKeySet, false);

    // Validation: unknown provider, empty key, too long
    assert.equal((await user1('PUT', '/api/user/api-keys/unknown', { apiKey: 'xyz' })).status, 400);
    assert.equal((await user1('PUT', '/api/user/api-keys/tfnsw', { apiKey: '   ' })).status, 400);
    assert.equal((await user1('PUT', '/api/user/api-keys/tfnsw', { apiKey: 'a'.repeat(600) })).status, 400);

    // Trains status reflects current user
    // User1 has tfnsw configured
    const trains1 = await user1('GET', '/api/trains/status');
    assert.equal(trains1.status, 200);
    assert.equal(trains1.json.configured, true);

    // User1 clears tfnsw key
    const clearRes = await user1('PUT', '/api/user/api-keys/tfnsw', { clear: true });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json.tfnswKeySet, false);
    assert.equal(clearRes.json.openaipKeySet, true);

    // After clearing, trains status for user1 is not configured
    const trains1After = await user1('GET', '/api/trains/status');
    assert.equal(trains1After.json.configured, false);

    // But user2 still configured!
    const trains2 = await user2('GET', '/api/trains/status');
    assert.equal(trains2.json.configured, true);
  } finally {
    await h.close();
  }
});
