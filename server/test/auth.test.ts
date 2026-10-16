import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuth, canRead, canEdit, isStaff, handleFrom, isAdminAccount, originAllowed, HANDLE, SessionUser } from '../src/auth.js';

const admin: SessionUser = { id: 'admin-1', role: 'admin' };
const contributor: SessionUser = { id: 'contrib-1', role: 'contributor' };
const otherContributor: SessionUser = { id: 'contrib-2', role: 'contributor' };

/**
 * needsAuth takes the instance's access mode as its fourth argument: `true`
 * lets a visitor read the public map, `false` (the default) makes the instance
 * private. Tests of public behaviour say so explicitly.
 */
const PUBLIC = true;
const PRIVATE = false;
const noPlugins = undefined;

test('needsAuth: signing in and out, the version and a share token need no session, in either mode', () => {
  for (const publicReads of [PUBLIC, PRIVATE]) {
    const mode = publicReads ? 'public' : 'private';
    assert.equal(needsAuth('GET', '/api/auth/status', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/auth/google/start', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/auth/discord/callback', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('POST', '/api/auth/logout', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/version', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/share/abc123', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/share/abc123/photos/xyz/file', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('GET', '/api/calendar/sometoken', noPlugins, publicReads), false, mode);
    assert.equal(needsAuth('PATCH', '/api/auth/me', noPlugins, publicReads), true, mode);
    assert.equal(needsAuth('GET', '/api/shares', noPlugins, publicReads), true, `${mode}: managing your own links is not the link`);
  }
});

test('needsAuth: with public reads on, a visitor may read the public map and nothing else', () => {
  for (const open of ['/api/spots', '/api/spots/abc', '/api/places', '/api/places/abc', '/api/routes', '/api/routes/abc',
    '/api/spots/abc/photos', '/api/photos/abc/file', '/api/photos/abc/thumb', '/api/Spots/', '/api/spots?bbox=1,2,3,4', '/api/settings', '/api/rail', '/api/fires', '/api/aurora', '/api/events', '/api/events/solo-12', '/api/Events/',
    '/api/profiles/Alice', '/api/Profiles/Alice/', '/api/community-events', '/api/community-events/abc', '/api/kit/photos/abc/file', '/api/kit/photos/abc/thumb',
    '/api/events/solo-12/rsvp', '/api/community-events/abc/rsvp',
    '/api/feed', '/api/feed?scope=all&before=2030-01-01T00:00:00Z', '/api/posts/abc/comments',
    '/api/plugins-web']) {
    assert.equal(needsAuth('GET', open, noPlugins, PUBLIC), false, open);
    assert.equal(needsAuth('HEAD', open, noPlugins, PUBLIC), false, `HEAD ${open}`);
  }
  // Radio used to be here; it is a plugin now, and a plugin's routes are open only where it declares them.
  assert.equal(needsAuth('GET', '/api/radio/places', noPlugins, PUBLIC), true);
  assert.equal(needsAuth('GET', '/api/radio/places/abc/stations', noPlugins, PUBLIC), true);
  assert.equal(needsAuth('GET', '/api/radio/stations/abc/listen', noPlugins, PUBLIC), true);
  // Writes to the new resources are never open, whatever their path.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/profiles/Alice', '/api/follows/Alice', '/api/kit/rides', '/api/kit/rides/abc', '/api/kit/gear/abc', '/api/kit/photos/abc', '/api/kit/photos/abc/file',
      '/api/community-events', '/api/community-events/abc', '/api/community-events/abc/rsvp', '/api/events/solo-12/rsvp',
      '/api/feed', '/api/checkins', '/api/posts/abc', '/api/posts/abc/vote', '/api/posts/abc/comments', '/api/comments/abc',
      '/api/chat', '/api/chat/abc', '/api/reports', '/api/reports/abc/resolve']) {
      assert.equal(needsAuth(method, path, noPlugins, PUBLIC), true, `${method} ${path}`);
    }
  }
  // Starring and hiding are somebody's own.
  assert.equal(needsAuth('PUT', '/api/events/solo-12/state', noPlugins, PUBLIC), true);
  assert.equal(needsAuth('GET', '/api/events/solo-12/state', noPlugins, PUBLIC), true);
  for (const closed of ['/api/geocode', '/api/weather', '/api/planes', '/api/buildings', '/api/roads', '/api/cameras/1/image',
    '/api/spots/abc/nearby', '/api/spots/abc/commons', '/api/spots/abc/trains', '/api/settings/x', '/api/settings/access', '/api/tasks', '/api/users',
    '/api/export.geojson', '/api/remotes', '/api/candidates', '/api/events-admin/settings', '/api/events-admin/events', '/api/nothing',
    '/api/profiles', '/api/profiles?q=al', '/api/profiles/Alice/extra', '/api/follows', '/api/follows/Alice', '/api/gear/catalog', '/api/kit/rides', '/api/kit/gear',
    '/api/kit/photos/abc', '/api/kit/photos/abc/other', '/api/community-events/abc/extra', '/api/events/solo-12/rsvp/extra',
    '/api/chat', '/api/chat/abc', '/api/reports', '/api/posts/abc', '/api/posts/abc/vote', '/api/feed/extra', '/api/posts/abc/comments/x', '/api/comments/abc',
    '/api/plugins-web/extra']) {
    assert.equal(needsAuth('GET', closed, noPlugins, PUBLIC), true, closed);
  }
});

test('needsAuth: every write needs a session, in either mode', () => {
  for (const publicReads of [PUBLIC, PRIVATE]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(needsAuth(method, '/api/spots', noPlugins, publicReads), true);
      assert.equal(needsAuth(method, '/api/spots/abc', noPlugins, publicReads), true);
    }
  }
});

/** Every GET a visitor may make when public reads are on: the whole of ANONYMOUS_READS, one path each. */
const PUBLIC_MAP_READS = ['/api/spots', '/api/spots/abc', '/api/places', '/api/places/abc', '/api/routes', '/api/routes/abc',
  '/api/spots/abc/photos', '/api/photos/abc/file', '/api/photos/abc/thumb', '/api/settings', '/api/rail', '/api/fires', '/api/aurora',
  '/api/events', '/api/events/solo-12', '/api/events/solo-12/rsvp', '/api/flyer/abc/def', '/api/profiles/Alice', '/api/community-events',
  '/api/community-events/abc', '/api/community-events/abc/rsvp', '/api/kit/photos/abc/file', '/api/kit/photos/abc/thumb', '/api/feed', '/api/posts/abc/comments',
  '/api/plugins-web'];

test('needsAuth: private is the default, and then even the public map needs a session', () => {
  for (const path of PUBLIC_MAP_READS) {
    assert.equal(needsAuth('GET', path), true, `default: ${path}`);
    assert.equal(needsAuth('GET', path, noPlugins, PRIVATE), true, `private: ${path}`);
    assert.equal(needsAuth('HEAD', path, noPlugins, PRIVATE), true, `private HEAD: ${path}`);
    assert.equal(needsAuth('GET', path, noPlugins, PUBLIC), false, `public: ${path}`);
  }
  // Casing, a trailing slash and a query string give no way round it.
  for (const path of ['/api/Spots/', '/api/spots?bbox=1,2,3,4', '/api/PLACES', '/api/Plugins-Web/']) {
    assert.equal(needsAuth('GET', path, noPlugins, PRIVATE), true, path);
  }
  // Nothing outside the open routes is open, by any method, even if a plugin claims a route is public.
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const path of ['/api/spots', '/api/nothing', '/api/settings/access', '/api/plugins/media.x/ping', '/api/auth/me', '/api/shares', '/api/calendar']) {
      assert.equal(needsAuth(method, path, () => true, PRIVATE), true, `${method} ${path}`);
    }
  }
});

test('needsAuth: only a literal true opens the public map', () => {
  for (const loose of [undefined, null, 0, 1, '', 'true', 'yes', {}] as unknown[]) {
    assert.equal(needsAuth('GET', '/api/places', noPlugins, loose as boolean), true, String(loose));
  }
  assert.equal(needsAuth('GET', '/api/places', noPlugins, true), false);
});

test('needsAuth: a plugin route is private in private mode, even one the plugin declares public', () => {
  const declared = () => true;
  assert.equal(needsAuth('GET', '/api/plugins/media.x/ping', declared, PUBLIC), false, 'public mode honours the declaration');
  assert.equal(needsAuth('GET', '/api/plugins/media.x/ping', declared, PRIVATE), true, 'private mode does not');
  assert.equal(needsAuth('GET', '/api/plugins/media.x/ping', declared), true, 'private is the default');
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

test('isStaff: admins and moderators; a moderator still edits nobody else\'s rows and reads no private ones', () => {
  const moderator: SessionUser = { id: 'mod-1', role: 'moderator' };
  assert.equal(isStaff(admin), true);
  assert.equal(isStaff(moderator), true);
  assert.equal(isStaff(contributor), false);
  assert.equal(isStaff(null), false);
  assert.equal(canEdit(contributor.id, moderator), false);
  assert.equal(canRead('private', contributor.id, moderator), false);
});

test('canEdit: owner or admin only, never anonymous', () => {
  assert.equal(canEdit(contributor.id, null), false);
  assert.equal(canEdit(contributor.id, otherContributor), false);
  assert.equal(canEdit(contributor.id, contributor), true);
  assert.equal(canEdit(contributor.id, admin), true);
});
