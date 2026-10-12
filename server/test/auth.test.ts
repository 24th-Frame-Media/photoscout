import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuth, canRead, canEdit, handleFrom, isAdminAccount, originAllowed, HANDLE, SessionUser } from '../src/auth.js';

const admin: SessionUser = { id: 'admin-1', role: 'admin' };
const contributor: SessionUser = { id: 'contrib-1', role: 'contributor' };
const otherContributor: SessionUser = { id: 'contrib-2', role: 'contributor' };

test('needsAuth: signing in and out, the version and a share token need no session', () => {
  assert.equal(needsAuth('GET', '/api/auth/status'), false);
  assert.equal(needsAuth('GET', '/api/auth/google/start'), false);
  assert.equal(needsAuth('GET', '/api/auth/discord/callback'), false);
  assert.equal(needsAuth('POST', '/api/auth/logout'), false);
  assert.equal(needsAuth('GET', '/api/version'), false);
  assert.equal(needsAuth('GET', '/api/share/abc123'), false);
  assert.equal(needsAuth('GET', '/api/share/abc123/photos/xyz/file'), false);
  assert.equal(needsAuth('PATCH', '/api/auth/me'), true);
  assert.equal(needsAuth('GET', '/api/shares'), true, 'managing your own links is not the link');
});

test('needsAuth: a visitor may read the public map and nothing else', () => {
  for (const open of ['/api/spots', '/api/spots/abc', '/api/places', '/api/places/abc', '/api/routes', '/api/routes/abc',
    '/api/spots/abc/photos', '/api/photos/abc/file', '/api/photos/abc/thumb', '/api/Spots/', '/api/spots?bbox=1,2,3,4', '/api/settings', '/api/rail', '/api/fires', '/api/aurora']) {
    assert.equal(needsAuth('GET', open), false, open);
  }
  for (const closed of ['/api/geocode', '/api/weather', '/api/planes', '/api/buildings', '/api/roads', '/api/cameras/1/image',
    '/api/spots/abc/nearby', '/api/spots/abc/commons', '/api/spots/abc/trains', '/api/settings/x', '/api/tasks', '/api/users',
    '/api/export.geojson', '/api/remotes', '/api/candidates', '/api/eventscout/test', '/api/nothing']) {
    assert.equal(needsAuth('GET', closed), true, closed);
  }
});

test('needsAuth: every write needs a session', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(needsAuth(method, '/api/spots'), true);
    assert.equal(needsAuth(method, '/api/spots/abc'), true);
  }
});

test('originAllowed: a write from another site is refused, one with no origin is not a browser', () => {
  const own = 'https://photoscout.example';
  assert.equal(originAllowed('POST', own, own), true);
  assert.equal(originAllowed('POST', 'https://evil.example', own), false);
  assert.equal(originAllowed('DELETE', 'https://photoscout.example.evil.example', own), false);
  assert.equal(originAllowed('POST', 'null', own), false, 'a sandboxed frame');
  assert.equal(originAllowed('POST', undefined, own), true);
  assert.equal(originAllowed('GET', 'https://evil.example', own), true, 'reads are left to CORS');
});

test('handleFrom: a tidy handle from a display name, never one that is taken', () => {
  const none = () => false;
  assert.equal(handleFrom('Track The Tom!', none), 'TrackTheTom');
  assert.equal(handleFrom('José Ñandú', none), 'JoseNandu');
  assert.equal(handleFrom('日本', none, () => 1234), 'driver_1234', 'nothing usable left');
  assert.equal(handleFrom('Sam', (h) => h === 'Sam', () => 7777), 'Sam_7777');
  assert.ok(HANDLE.test(handleFrom('x'.repeat(80), none)));
  assert.ok(HANDLE.test(handleFrom('a_very_long_name_that_goes_on', (h) => !h.includes('_1'), () => 1000)), 'still fits with a suffix');
});

test('isAdminAccount: only an exact provider:id named in ADMIN_IDS', () => {
  const ids = 'google:111, discord:222';
  assert.equal(isAdminAccount('google', '111', ids), true);
  assert.equal(isAdminAccount('discord', '222', ids), true);
  assert.equal(isAdminAccount('discord', '111', ids), false, 'the same id at another provider is somebody else');
  assert.equal(isAdminAccount('google', '11', ids), false);
  assert.equal(isAdminAccount('google', '111', undefined), false);
  assert.equal(isAdminAccount('google', '', 'google:'), false);
});

test('canRead: public and unlisted are always readable', () => {
  assert.equal(canRead('public', 'someone-else', null), true);
  assert.equal(canRead('unlisted', 'someone-else', null), true);
  assert.equal(canRead('unlisted', 'someone-else', contributor), true);
});

test('canRead: private is owner or admin only', () => {
  assert.equal(canRead('private', contributor.id, null), false);
  assert.equal(canRead('private', contributor.id, otherContributor), false);
  assert.equal(canRead('private', contributor.id, contributor), true);
  assert.equal(canRead('private', contributor.id, admin), true);
});

test('canEdit: owner or admin only, never anonymous', () => {
  assert.equal(canEdit(contributor.id, null), false);
  assert.equal(canEdit(contributor.id, otherContributor), false);
  assert.equal(canEdit(contributor.id, contributor), true);
  assert.equal(canEdit(contributor.id, admin), true);
});
