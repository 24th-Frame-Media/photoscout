import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTAGRAM, parseCommunityEvent, parseGear, parseProfile, parseRide } from '../src/bodyLimits.js';
import { searchCatalog, type CatalogItem } from '../src/gearCatalog.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

test('parseProfile: bio is trimmed and capped, Instagram is a handle and never a URL', () => {
  assert.deepEqual(parseProfile({}), { ok: true, value: {} });
  assert.deepEqual(parseProfile({ bio: '  hi ' }), { ok: true, value: { bio: 'hi' } });
  assert.deepEqual(parseProfile({ instagram: '@a.b_c' }), { ok: true, value: { instagram: 'a.b_c' } });
  assert.deepEqual(parseProfile({ instagram: null }), { ok: true, value: { instagram: '' } });
  for (const instagram of ['@@x', 'a b', 'a/b', 'https://instagram.com/x', 'x?y=1', '<b>', 'x'.repeat(31), '.', '...', 'é']) {
    assert.equal(parseProfile({ instagram }).ok, false, instagram);
  }
  assert.equal(parseProfile({ bio: 'x'.repeat(500) }).ok, true);
  assert.equal(parseProfile({ bio: 'x'.repeat(501) }).ok, false);
  assert.equal(parseProfile('nope').ok, false);
  assert.equal(INSTAGRAM.test('a'.repeat(30)), true);
});

test('parseRide: required fields, year range, unknown kind', () => {
  const ok = parseRide({ kind: 'car', make: ' Mazda ', model: 'MX-5' }, undefined, new Date('2026-06-01'));
  assert.deepEqual(ok, { ok: true, value: { kind: 'car', make: 'Mazda', model: 'MX-5', year: null, nickname: '', notes: '' } });
  const year = (y: unknown) => parseRide({ kind: 'car', make: 'a', model: 'b', year: y }, undefined, new Date('2026-06-01')).ok;
  assert.deepEqual([year(1885), year(1886), year(2027), year(2028), year(2000.5), year('2000'), year(null)], [false, true, true, false, false, false, true]);
  assert.equal(parseRide({ kind: 'tank', make: 'a', model: 'b' }).ok, false);
  assert.equal(parseRide({ make: 'a', model: 'b' }).ok, false, 'kind is required');
  const current = { kind: 'car' as const, make: 'a', model: 'b', year: 2000, nickname: 'n', notes: 'z' };
  assert.deepEqual(parseRide({ notes: 'new' }, current), { ok: true, value: { ...current, notes: 'new' } });
  assert.equal(parseRide({ kind: 'plane' }, current).ok, false, 'an edit cannot smuggle in an unknown kind');
  assert.equal(parseRide({ make: ' ' }, current).ok, false);
});

test('parseGear: kinds and lengths', () => {
  assert.equal(parseGear({ kind: 'camera', brand: 'Sony', name: 'A9' }).ok, true);
  assert.equal(parseGear({ kind: 'drone', brand: 'Sony', name: 'A9' }).ok, false);
  assert.equal(parseGear({ kind: 'lens', brand: 'Sony', name: 'x'.repeat(101) }).ok, false);
  assert.equal(parseGear({ kind: 'lens', brand: 'Sony', name: 'a', notes: 'x'.repeat(501) }).ok, false);
});

test('parseCommunityEvent: the start is ahead and within 400 days, the end is after it and within 14', () => {
  const base = { title: 'T', startTime: at(1), lat: 1, lng: 2 };
  const p = (patch: object) => parseCommunityEvent({ ...base, ...patch }, NOW);
  assert.equal(p({}).ok, true);
  assert.equal(p({ startTime: at(-0.001) }).ok, false);
  assert.equal(p({ startTime: at(400) }).ok, true);
  assert.equal(p({ startTime: at(401) }).ok, false);
  assert.equal(p({ endTime: at(1) }).ok, false);
  assert.equal(p({ endTime: at(15) }).ok, true);
  assert.equal(p({ endTime: at(15.5) }).ok, false);
  assert.equal(p({ startTime: '2026-07-01T10:00:00+10:00' }).ok, true, 'an offset is a zone');
  assert.equal(p({ startTime: '2026-07-01T10:00:00' }).ok, false, 'no zone is a guess');
  const result = p({ startTime: '2026-07-01T10:00:00+10:00' });
  assert.equal(result.ok && result.value.startTime, '2026-07-01T00:00:00.000Z', 'stored as UTC');
  assert.equal(p({ lat: NaN }).ok, false);
  assert.equal(p({ lng: Infinity }).ok, false);
  assert.equal(p({ visibility: 'private' }).ok, false);
});

test('parseCommunityEvent: an event already under way keeps its start through an edit of something else', () => {
  const current = {
    title: 'T', description: '', startTime: at(-1), endTime: at(1), venueName: '', address: '', lat: 1, lng: 2, priceText: '', visibility: 'public' as const,
  };
  assert.equal(parseCommunityEvent({ title: 'New' }, NOW, current).ok, true);
  assert.equal(parseCommunityEvent({ startTime: at(-2) }, NOW, current).ok, false, 'but moving it to the past is not allowed');
  assert.equal(parseCommunityEvent({ endTime: at(-0.5) }, NOW, current).ok, true, 'an end after the start is fine');
});

test('searchCatalog: prefix on the name or on brand and name, case-insensitive, 20 at most', () => {
  const items: CatalogItem[] = [
    { brand: 'Canon', name: 'EF 70-200mm f/2.8L', kind: 'lens' },
    { brand: 'Nikon', name: 'F3', kind: 'camera' },
    ...Array.from({ length: 30 }, (_, i) => ({ brand: 'Sigma', name: `Art ${i}`, kind: 'lens' as const })),
  ];
  assert.deepEqual(searchCatalog(items, 'ef 70').map((i) => i.brand), ['Canon']);
  assert.deepEqual(searchCatalog(items, 'NIKON f').map((i) => i.name), ['F3']);
  assert.deepEqual(searchCatalog(items, '70-200'), [], 'not a substring');
  assert.equal(searchCatalog(items, 'sigma').length, 20);
  assert.deepEqual(searchCatalog(items, '  '), []);
});
