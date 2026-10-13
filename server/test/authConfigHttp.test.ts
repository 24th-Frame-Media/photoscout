import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';

const SECRET = 'discord-secret-from-the-ui';

test('auth config over HTTP: admins only, and a pair saved there is used to sign in', async () => {
  const h = await startApp({ DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', ADMIN_IDS: 'google:admin1' });
  try {
    const admin = h.client(), member = h.client();
    await h.signIn(admin, 'google', { id: 'admin1', name: 'Admin' });
    await h.signIn(member, 'google', { id: 'm1', name: 'Member' });
    assert.equal((await member('GET', '/api/auth-config')).status, 403);
    assert.equal((await member('PUT', '/api/auth-config/discord', { clientId: 'x', clientSecret: 'y' })).status, 403);
    assert.deepEqual((await admin('GET', '/api/auth/status')).json.providers, ['google']);

    const put = await admin('PUT', '/api/auth-config/discord', { clientId: '42', clientSecret: SECRET });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(SECRET));
    assert.deepEqual((await admin('GET', '/api/auth/status')).json.providers, ['google', 'discord']);

    const fresh = h.client();
    const back = await h.signIn(fresh, 'discord', { id: 'd1', name: 'Newcomer' });
    assert.equal(back.status, 302);
    assert.equal((await fresh('GET', '/api/auth/status')).json.authed, true);
  } finally { await h.close(); }
});
