import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommunityEvent, EventItem } from '../src/api.js';
import {
  applyFilters, categoriesOf, COMMUNITY_CATEGORY, communityToItem, dateWindow, DEFAULT_FILTERS, dayKey, foldSeries, formatWhen, groupByDay, isMultiDay, isOver, mergeEvents, multiDaySpan,
} from '../src/events.js';
import { eventsGeoJSON } from '../src/map/layers.js';
import { categoryOf } from '../src/map/legend.js';

// Wednesday 9 January 2030, noon. Every date below is built in local time, as the page reads them.
const NOW = new Date(2030, 0, 9, 12);
const at = (day: number, hour = 10, month = 0) => new Date(2030, month, day, hour).toISOString();

function event(group: string, over: Partial<EventItem> = {}): EventItem {
  return {
    group, title: `Event ${group}`, description: '', startTime: at(10), endTime: null, venueName: '', address: '', locality: '',
    lat: null, lng: null, imageUrl: '', category: '', priceText: '', isOnline: false, dateOnly: false, photoScore: 0,
    series: '', url: '', starred: false, hidden: false, ...over,
  };
}
const groups = (list: { group: string }[]) => list.map((e) => e.group);

test('dateWindow: what each chip stands for, from a Wednesday', () => {
  assert.equal(dateWindow('all', NOW), null);
  assert.deepEqual(dateWindow('today', NOW), [new Date(2030, 0, 9), new Date(2030, 0, 10)]);
  assert.deepEqual(dateWindow('week', NOW), [new Date(2030, 0, 9), new Date(2030, 0, 16)]);
  assert.deepEqual(dateWindow('month', NOW), [new Date(2030, 0, 9), new Date(2030, 1, 9)]);
  assert.deepEqual(dateWindow('weekend', NOW), [new Date(2030, 0, 12), new Date(2030, 0, 14)], 'the coming Saturday and Sunday');
  assert.deepEqual(dateWindow('weekend', new Date(2030, 0, 13, 9)), [new Date(2030, 0, 13), new Date(2030, 0, 14)], 'on a Sunday, what is left of this one');
  assert.deepEqual(dateWindow('weekend', new Date(2030, 0, 12, 9)), [new Date(2030, 0, 12), new Date(2030, 0, 14)]);
});

test('applyFilters: search, date chip, category, shortlist and hidden', () => {
  const list = [
    event('a', { title: 'Mount Panorama practice', startTime: at(10), category: 'Motorsport' }),
    event('b', { title: 'Farmers market', venueName: 'Kings Parade', startTime: at(12), category: 'Market', starred: true }),
    event('c', { title: 'Choir', description: 'Songs at the PANORAMA hall', startTime: at(20), hidden: true }),
    event('d', { title: 'Next month', startTime: at(9, 10, 1), category: 'Market' }),
  ];
  const run = (patch: Partial<typeof DEFAULT_FILTERS>) => groups(applyFilters(list, { ...DEFAULT_FILTERS, ...patch }, NOW));
  assert.deepEqual(run({}), ['a', 'b', 'd'], 'hidden is out of sight by default');
  assert.deepEqual(run({ showHidden: true }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(run({ search: ' panorama ', showHidden: true }), ['a', 'c'], 'title, venue and description, any case');
  assert.deepEqual(run({ search: 'kings' }), ['b']);
  assert.deepEqual(run({ category: 'Market' }), ['b', 'd']);
  assert.deepEqual(run({ starredOnly: true }), ['b']);
  assert.deepEqual(run({ dateChip: 'weekend' }), ['b']);
  assert.deepEqual(run({ dateChip: 'week' }), ['a', 'b']);
  assert.deepEqual(run({ dateChip: 'month' }), ['a', 'b'], 'to the same day next month, exclusive');
  assert.deepEqual(run({ dateChip: 'week', category: 'Market', starredOnly: true }), ['b']);
});

test('categoriesOf: the distinct non-empty ones, sorted', () => {
  assert.deepEqual(categoriesOf([event('a', { category: 'Market' }), event('b'), event('c', { category: 'Air' }), event('d', { category: 'Market' })]), ['Air', 'Market']);
});

test('isOver: an end if there is one, otherwise the whole of the day it starts on', () => {
  const now = NOW.getTime();
  assert.equal(isOver({ startTime: at(9, 8), endTime: at(9, 11) }, now), true);
  assert.equal(isOver({ startTime: at(9, 8), endTime: at(9, 14) }, now), false);
  assert.equal(isOver({ startTime: at(9, 0), endTime: null }, now), false, 'an all-day event runs to midnight');
  assert.equal(isOver({ startTime: at(8, 20), endTime: null }, now), true);
  assert.equal(isOver({ startTime: 'not a date', endTime: null }, now), false);
});

test('foldSeries: dates of a series share the first one’s card, in order', () => {
  const list = [event('a', { series: 's1' }), event('b'), event('c', { series: 's1' }), event('d', { series: 's2' }), event('e', { series: 's1' })];
  const cards = foldSeries(list);
  assert.deepEqual(cards.map((c) => c.ev.group), ['a', 'b', 'd']);
  assert.deepEqual(groups(cards[0].dates), ['a', 'c', 'e']);
  assert.deepEqual(groups(cards[1].dates), ['b'], 'an event with no series is its own card');
});

test('groupByDay: by the day it starts, each day in time order', () => {
  const byDay = groupByDay([event('late', { startTime: at(10, 18) }), event('next', { startTime: at(11, 9) }), event('early', { startTime: at(10, 8) })]);
  assert.deepEqual([...byDay.keys()], ['2030-01-10', '2030-01-11']);
  assert.deepEqual(groups(byDay.get('2030-01-10')!), ['early', 'late']);
  assert.equal(dayKey(new Date(2030, 8, 5)), '2030-09-05');
});

test('multi-day events: a span of days, but not a late-night finish', () => {
  const fri = { startTime: at(11, 18), endTime: at(14, 12), dateOnly: false };
  assert.equal(isMultiDay(fri), true);
  assert.equal(multiDaySpan(fri), 4);
  const lateNight = { startTime: at(11, 20), endTime: new Date(2030, 0, 12, 1).toISOString(), dateOnly: false };
  assert.equal(isMultiDay(lateNight), false, 'ends at 1am, so it is one evening');
  assert.equal(isMultiDay({ startTime: at(11, 0), endTime: at(13, 0), dateOnly: true }), true);
  assert.equal(isMultiDay({ startTime: at(11), endTime: null, dateOnly: false }), false);
  assert.equal(multiDaySpan({ startTime: at(11), endTime: null }), 1);
});

test('formatWhen: a day alone for a day-only event, a span for a long one, a time range for the rest', () => {
  assert.ok(!/\d:\d\d/.test(formatWhen(event('a', { dateOnly: true, startTime: at(10, 0) }), {}, NOW)), 'no clock time invented');
  const multi = event('b', { startTime: at(11, 18), endTime: at(14, 12) });
  assert.ok(formatWhen(multi, {}, NOW).includes('–'));
  assert.ok(formatWhen(multi, { full: true }, NOW).endsWith('(4 days)'));
  const timed = formatWhen(event('c', { startTime: at(10, 9), endTime: at(10, 11) }), {}, NOW);
  assert.ok(timed.includes('·') && timed.includes('–'), timed);
  assert.ok(!formatWhen(event('d'), {}, NOW).includes('2030'), 'the year only when it is not this one');
  assert.ok(formatWhen(event('e'), {}, new Date(2031, 0, 1)).includes('2030'));
});

test('eventsGeoJSON: only events with a position that are still to come and not hidden, as lng/lat points', () => {
  const fc = eventsGeoJSON([
    event('shown', { lat: -33.4, lng: 149.5, title: 'Panorama', category: 'Motorsport' }),
    event('no-position'),
    event('no-lng', { lat: -33.4 }),
    event('hidden', { lat: -33.4, lng: 149.5, hidden: true }),
    event('over', { lat: -33.4, lng: 149.5, startTime: at(8, 10), endTime: at(8, 12) }),
    event('zero', { lat: 0, lng: 0 }),
  ], NOW.getTime());
  assert.equal(fc.type, 'FeatureCollection');
  assert.deepEqual(fc.features.map((f) => f.id), ['shown', 'zero'], '0,0 is a position, not a missing one');
  assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [149.5, -33.4] });
  assert.deepEqual(fc.features[0].properties, { group: 'shown', title: 'Panorama', category: 'Motorsport' });
  assert.deepEqual(eventsGeoJSON([], NOW.getTime()).features, []);
});

test('the legend groups the event layers under Events', () => {
  for (const id of ['event-clusters', 'event-cluster-count', 'event-points']) assert.equal(categoryOf({ id, type: 'circle' }), 'events', id);
});

// --- community events ---------------------------------------------------------

const community = (id: string, over: Partial<CommunityEvent> = {}): CommunityEvent => ({
  id, ownerId: 'u1', owner: { username: 'Alice', avatar: '' }, title: `Meet ${id}`, description: 'Bring a camera', startTime: at(10, 9),
  endTime: null, venueName: 'Showground', address: '', lat: -33.4, lng: 149.5, priceText: 'Free', visibility: 'public', going: 3, isGoing: true,
  createdAt: at(1), updatedAt: at(1), ...over,
});

test('communityToItem: marked as community, never shortlisted or hidden, and its group cannot clash with a scraped one', () => {
  const ev = communityToItem(community('abc'));
  assert.equal(ev.community, true);
  assert.equal(ev.group, 'community:abc');
  assert.equal(ev.communityId, 'abc');
  assert.equal(ev.category, COMMUNITY_CATEGORY);
  assert.equal(ev.organiser, 'Alice');
  assert.equal(ev.going, 3);
  assert.equal(ev.isGoing, true);
  assert.equal(ev.starred || ev.hidden, false);
  assert.equal(ev.lat, -33.4);
  assert.equal(event('x').community, undefined, 'a scraped event is not marked');
});

test('mergeEvents: one list in start order, scraped first on a tie, community events labelled', () => {
  const scraped = [event('s1', { startTime: at(12) }), event('s2', { startTime: at(10, 9) })];
  const merged = mergeEvents(scraped, [community('c1', { startTime: at(11) }), community('c2', { startTime: at(10, 9) })]);
  assert.deepEqual(groups(merged), ['s2', 'community:c2', 'community:c1', 's1']);
  assert.deepEqual(merged.map((e) => Boolean(e.community)), [false, true, true, false]);
  assert.deepEqual(groups(mergeEvents(scraped, [])), ['s2', 's1']);
  assert.deepEqual(groups(mergeEvents([], [])), []);
  assert.deepEqual(groups(mergeEvents([event('bad', { startTime: 'soon' })], [community('c')])), ['community:c', 'bad'], 'an undated event sinks to the end');
});

test('merged community events flow through the filters, the series fold and the map layer like any other', () => {
  const merged = mergeEvents([event('s', { startTime: at(10, 8), lat: 1, lng: 2 })], [community('c', { startTime: at(10, 9) })]);
  assert.deepEqual(groups(applyFilters(merged, { ...DEFAULT_FILTERS, category: COMMUNITY_CATEGORY }, NOW)), ['community:c']);
  assert.deepEqual(groups(applyFilters(merged, { ...DEFAULT_FILTERS, search: 'showground' }, NOW)), ['community:c']);
  assert.deepEqual(groups(applyFilters(merged, { ...DEFAULT_FILTERS, starredOnly: true }, NOW)), [], 'a community event cannot be on the shortlist');
  assert.equal(foldSeries(merged).length, 2, 'an empty series does not fold two events together');
  assert.deepEqual(categoriesOf(merged), [COMMUNITY_CATEGORY]);
  const features = eventsGeoJSON(merged, NOW.getTime()).features;
  assert.deepEqual(features.map((f) => f.properties?.group), ['s', 'community:c']);
  assert.deepEqual(groupByDay(merged).get(dayKey(new Date(at(10, 9))))?.map((e) => e.group), ['s', 'community:c']);
});
