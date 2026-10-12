import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestRelease } from '../src/map/overture.js';

test('latestRelease: newest child release id from the STAC catalog', () => {
  const link = (id: string) => ({ rel: 'child', href: `https://stac.overturemaps.org/${id}/catalog.json` });
  assert.equal(latestRelease({ links: [{ rel: 'root', href: 'https://stac.overturemaps.org/catalog.json' }, link('2026-08-19.0'), link('2026-09-23.1'), link('2026-09-23.0')] }), '2026-09-23.1');
  assert.equal(latestRelease({ links: [] }), null);
  assert.equal(latestRelease({}), null);
});
