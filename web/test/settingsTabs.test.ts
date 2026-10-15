import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, tabFromHash } from '../src/settings/tabs.js';

test('a hash lands on its tab, and the ids from before the grouping still land', () => {
  assert.equal(tabFromHash('#crawler'), 'crawler');
  assert.equal(tabFromHash('#home'), 'areas', 'Home & areas became Areas');
  assert.equal(tabFromHash('#places'), 'venues', "the engine's Places became Venues");
  assert.equal(tabFromHash(''), 'areas');
  assert.equal(tabFromHash('#nonsense'), 'areas');
});

test('the model tab is labelled AI models but keeps its id, so #model still lands on it', () => {
  const tab = GROUPS.flatMap((g) => g.tabs).find((t) => t.id === 'model');
  assert.equal(tab?.label, 'AI models');
  assert.equal(tabFromHash('#model'), 'model');
});

test('every tab is in exactly one group, and a visitor still has somewhere to go', () => {
  const ids = GROUPS.flatMap((g) => g.tabs.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length);
  const open = GROUPS.flatMap((g) => g.tabs.filter((t) => !t.admin).map((t) => t.id));
  assert.deepEqual(open.sort(), ['account', 'areas', 'feeds', 'waze']);
});
