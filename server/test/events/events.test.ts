import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bumpEventsVersion, eventsVersion, toListItem } from '../../src/events/events.js';
import type { MergedEvent } from '../../src/events/events.js';

function event(over: Partial<MergedEvent> = {}): MergedEvent {
  return {
    group: 'g1', title: 'Bathurst Weekend Run', rawTitle: 'raw title',
    description: 'A drive over the mountain.', startTime: '2026-09-25T09:00:00.000Z', endTime: null,
    venueName: 'Mount Panorama', address: '1 Mountain Straight, Bathurst NSW',
    locality: 'Bathurst', place: 'Bathurst', area: 'Bathurst', lat: null, lng: null,
    imageUrl: '', category: 'Motorsport', priceText: '', isOnline: false, dateOnly: false,
    photoScore: 70, starred: false, hidden: false,
    firstSeenAt: null, shownAt: null, notEvent: '', pending: false, unknownLocation: false, culled: null,
    sources: [{ source: 'MIDNIGHT_SPEC', url: 'https://example.test/1' }],
    images: [],
    members: [{ id: 1, source: 'MIDNIGHT_SPEC', title: 'raw', url: 'https://example.test/1', imageUrl: '', startTime: '', venueName: '', parent: false }],
    manual: false, series: '', note: '', enriched: {}, edited: [],
    rawDescription: 'the original blurb before it was cleaned up',
    ...over,
  };
}

// --- toListItem --------------------------------------------------------------

test('the list shape drops the raw fields and trims each member', () => {
  const item = toListItem(event());
  assert.equal('rawTitle' in item, false);
  assert.equal('rawDescription' in item, false);
  assert.deepEqual(item.members, [{ id: 1, source: 'MIDNIGHT_SPEC', title: 'raw', parent: false }]);
  // Everything the grid actually reads survives untouched.
  assert.equal(item.title, 'Bathurst Weekend Run');
  assert.deepEqual(item.sources, [{ source: 'MIDNIGHT_SPEC', url: 'https://example.test/1' }]);
});

// --- version counter ----------------------------------------------------------

test('bumpEventsVersion moves the counter every write writers can key an ETag or cache off', () => {
  const before = eventsVersion();
  bumpEventsVersion();
  assert.equal(eventsVersion(), before + 1);
  bumpEventsVersion();
  assert.equal(eventsVersion(), before + 2);
});
