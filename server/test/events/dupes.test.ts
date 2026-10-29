import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDupePrompt,
  buildDupeSchema,
  candidatePairs,
  eventKey,
  joinGroups,
  pairHash,
  pairId,
  PERSON_HASH,
  readDupeVerdict,
  titleSimilarity,
  type DupeEvent,
} from '../../src/events/enrich/dupePairs.js';
import { ENRICH_JOBS } from '../../src/events/enrich/schema.js';
import { answeredPairs, joinedPairs, recordVerdict } from '../../src/events/enrich/dupeStore.js';
import { clearEnrichment, eventJobs } from '../../src/events/enrich/pipeline.js';
import { db } from '../../src/events/db.js';
import { recomputeDedupeGroups } from '../../src/events/regroup.js';
import { bumpEventsVersion, getMergedEvents, mergeGroups, unmergeGroup } from '../../src/events/events.js';
import { DEFAULT_SETTINGS } from '../../src/events/sources/types.js';
import { useZone } from './zone.js';

/**
 * The duplicate check: which pairs are asked about, what is asked, what is
 * believed of the answer, and how a yes becomes one group.
 */

// Well ahead of any clock this runs on, so nothing is "over".
const NOW = new Date(2031, 2, 1, 12);
const local = (d: number, h = 19, mi = 0): string => new Date(2031, 2, d, h, mi).toISOString();

let nextId = 1;
function ev(over: Partial<DupeEvent> = {}): DupeEvent {
  const id = over.id ?? nextId++;
  return {
    id,
    key: eventKey('test-dupes', `e${id}`),
    title: `Event ${id}`,
    description: '',
    venueName: '',
    address: '',
    startTime: local(15),
    endTime: null,
    dateOnly: false,
    lat: null,
    lng: null,
    source: 'test-dupes',
    group: `g${id}`,
    manual: false,
    ...over,
  };
}

const ids = (pairs: { a: DupeEvent; b: DupeEvent }[]): string[] => pairs.map((p) => `${p.a.id}-${p.b.id}`);

test('the job is listed, on by default, and kept out of the per-event jobs', () => {
  const job = ENRICH_JOBS.find((j) => j.key === 'dupes');
  assert.equal(job?.label, 'Find duplicates');
  assert.ok(job?.hint);
  assert.ok(DEFAULT_SETTINGS.llmJobs.includes('dupes'));
  assert.ok(!eventJobs().includes('dupes'));
});

test('pairs on one day are included when near, at one venue, or named alike', (t) => {
  useZone(t, 'Australia/Sydney');
  const near1 = ev({ id: 101, title: 'Alpha', lat: -33.86, lng: 151.2 });
  const near2 = ev({ id: 102, title: 'Zulu', lat: -33.865, lng: 151.205 });
  const venue1 = ev({ id: 103, title: 'Quiet Night', venueName: 'The Old Pub' });
  const venue2 = ev({ id: 104, title: 'Loud Day', venueName: 'the old pub' });
  const name1 = ev({ id: 105, title: 'Bathurst Swap Meet 2031' });
  const name2 = ev({ id: 106, title: 'Swap Meet Bathurst' });
  const far = ev({ id: 107, title: 'Nothing Alike', lat: -35, lng: 149 });
  const got = ids(candidatePairs([near1, near2, venue1, venue2, name1, name2, far], new Map(), NOW));
  assert.deepEqual(got.sort(), ['101-102', '103-104', '105-106']);
});

test('a multi-day event pairs with a listing on any of its days, and different days do not pair', (t) => {
  useZone(t, 'Australia/Sydney');
  const festival = ev({ id: 111, title: 'Folk Festival', venueName: 'Showground', startTime: local(14, 10), endTime: local(16, 17) });
  const day2 = ev({ id: 112, title: 'Folk Festival Saturday', venueName: 'Showground', startTime: local(15, 9) });
  const later = ev({ id: 113, title: 'Folk Festival', venueName: 'Showground', startTime: local(20, 10) });
  assert.deepEqual(ids(candidatePairs([festival, day2, later], new Map(), NOW)), ['111-112']);
});

test('the local day decides, not the UTC one', (t) => {
  useZone(t, 'Australia/Sydney');
  // 8am and 11pm on the 15th are the 14th and the 15th in UTC.
  const morning = ev({ id: 121, title: 'Market', venueName: 'Town Hall', startTime: local(15, 8) });
  const evening = ev({ id: 122, title: 'Market', venueName: 'Town Hall', startTime: local(15, 23) });
  assert.deepEqual(ids(candidatePairs([morning, evening], new Map(), NOW)), ['121-122']);
});

test('what the matcher grouped, what a person grouped, and what is over are left out', (t) => {
  useZone(t, 'Australia/Sydney');
  const base = { venueName: 'The Old Pub' };
  const grouped1 = ev({ id: 131, ...base, group: 'same' });
  const grouped2 = ev({ id: 132, ...base, group: 'same' });
  const manual = ev({ id: 133, ...base, manual: true });
  const free = ev({ id: 134, ...base });
  const past = ev({ id: 135, ...base, startTime: new Date(2020, 0, 1, 19).toISOString() });
  const got = ids(candidatePairs([grouped1, grouped2, manual, free, past], new Map(), NOW));
  // 131/132 share a group; 133 is manual; 135 is over. Only the free one pairs, with each of 131 and 132.
  assert.deepEqual(got.sort(), ['131-134', '132-134']);
});

test('an answered pair is skipped until a listing changes, and a person\u2019s answer is never reopened', (t) => {
  useZone(t, 'Australia/Sydney');
  const a = ev({ id: 141, venueName: 'The Old Pub', description: 'Doors at 7' });
  const b = ev({ id: 142, venueName: 'The Old Pub' });
  const answered = new Map([[pairId(a.key, b.key), pairHash(a, b)]]);
  assert.deepEqual(candidatePairs([a, b], answered, NOW), []);

  const edited = { ...a, description: 'Doors at 8, tickets at the door' };
  assert.deepEqual(ids(candidatePairs([edited, b], answered, NOW)), ['141-142'], 'a changed listing is asked again');
  assert.notEqual(pairHash(a, b), pairHash(edited, b));
  assert.equal(pairHash(a, b), pairHash(b, a), 'the order the pair arrives in does not matter');

  const person = new Map([[pairId(a.key, b.key), PERSON_HASH]]);
  assert.deepEqual(candidatePairs([edited, b], person, NOW), []);
});

test('the cap holds, and the closest pairs come first', (t) => {
  useZone(t, 'Australia/Sydney');
  const events = [
    ev({ id: 151, lat: -33.86, lng: 151.2 }),
    ev({ id: 152, lat: -33.869, lng: 151.2 }), // 1 km
    ev({ id: 153, lat: -33.8601, lng: 151.2 }), // ~11 m
    ev({ id: 154, lat: -33.864, lng: 151.2 }), // ~450 m
  ];
  const all = candidatePairs(events, new Map(), NOW);
  assert.equal(all.length, 6);
  assert.equal(ids([all[0]])[0], '151-153');
  assert.deepEqual(ids(candidatePairs(events, new Map(), NOW, 2)), ids(all.slice(0, 2)));
});

test('title similarity is word overlap, ignoring years and filler', () => {
  assert.ok(titleSimilarity('Bathurst Swap Meet 2031', 'Swap Meet Bathurst') >= 0.99);
  assert.equal(titleSimilarity('Cars and Coffee', 'Opera Gala'), 0);
  assert.equal(titleSimilarity('', 'Opera Gala'), 0);
});

test('the prompt shows both listings, trimmed, in local time, and says to be conservative', (t) => {
  useZone(t, 'Australia/Sydney');
  const a = ev({ id: 161, title: 'Swap Meet', description: 'x'.repeat(3000), venueName: 'Showground', address: '1 Main St', source: 'facebook' });
  const b = ev({ id: 162, title: 'Swap Meet tickets', dateOnly: true, source: 'eventbrite' });
  const prompt = buildDupePrompt(a, b);
  assert.match(prompt, /--- LISTING A ---\ntitle: Swap Meet\n/);
  assert.match(prompt, /--- LISTING B ---\ntitle: Swap Meet tickets\n/);
  assert.match(prompt, /venue: Showground\naddress: 1 Main St\nsource: facebook\n/);
  assert.match(prompt, /source: eventbrite/);
  assert.ok(prompt.includes('x'.repeat(1500)) && !prompt.includes('x'.repeat(1501)), 'a blurb is cut at 1500');
  assert.match(prompt, /starts: .*15 March 2031.*7:00/i);
  const second = prompt.slice(prompt.indexOf('LISTING B'));
  assert.doesNotMatch(second.split('venue:')[0], /\d:\d\d/, 'a day with no time is not given a made-up hour');
  assert.match(prompt, /when you cannot tell, the answer is false/);
  assert.match(prompt, /two sessions/);
  assert.match(prompt, /different venues/);
});

test('the schema asks for the reason before the verdict', () => {
  const schema = buildDupeSchema() as { properties: Record<string, { type: string }>; required: string[] };
  assert.deepEqual(Object.keys(schema.properties), ['reason', 'sameEvent']);
  assert.equal(schema.properties.sameEvent.type, 'boolean');
  assert.deepEqual(schema.required, ['reason', 'sameEvent']);
});

test('an answer is believed only when it is a boolean, and a yes only with its reason', () => {
  assert.deepEqual(readDupeVerdict({ sameEvent: true, reason: ' Same night,\n same pub. ' }), { same: true, reason: 'Same night, same pub.' });
  assert.deepEqual(readDupeVerdict({ sameEvent: false, reason: 'Different venues' }), { same: false, reason: 'Different venues' });
  assert.equal(readDupeVerdict({ sameEvent: true, reason: '' })?.same, false);
  assert.equal(readDupeVerdict({ sameEvent: 'yes', reason: 'x' }), null);
  assert.equal(readDupeVerdict('true'), null);
  assert.equal(readDupeVerdict(null), null);
  assert.equal(readDupeVerdict({ sameEvent: true, reason: 'y'.repeat(900) })?.reason.length, 300);
});

test('a yes joins two whole groups, and a chain of them joins all', () => {
  const groups = new Map([[1, 'ga'], [2, 'ga'], [3, 'gb'], [4, 'gc'], [5, 'gd']]);
  const joined = joinGroups(groups, [[2, 3], [3, 4]]);
  assert.deepEqual([1, 2, 3, 4].map((i) => joined.get(i)), ['ga', 'ga', 'ga', 'ga'], 'the least id of the set');
  assert.equal(joined.get(5), 'gd', 'an unrelated event is left alone');
  assert.equal(joinGroups(groups, [[1, 99]]).get(1), 'ga', 'an event with no group is ignored');
  assert.deepEqual([...joinGroups(groups, [])], [...groups]);
  assert.equal(joinGroups(groups, [[5, 4], [4, 5]]).get(5), 'gc');
});

// --- the database ---

const SOURCE = 'test-dupes-db';

function insert(sourceId: string, title: string, over: Record<string, string | number | null> = {}): number {
  const row = {
    source: SOURCE, source_id: sourceId, title, start_time: local(18, 19), venue_name: 'Dupes Test Pub',
    ...over,
  };
  const cols = Object.keys(row);
  return Number(
    db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(Object.values(row) as (string | number | null)[])).lastInsertRowid
  );
}

function cleanup(): void {
  db.prepare('DELETE FROM events WHERE source = ?').run(SOURCE);
  db.prepare('DELETE FROM event_pair_verdict WHERE a_key LIKE ?').run(`${SOURCE}%`);
}

// The refresh bumps the version after regrouping, which is what lets the merged list be read afresh.
function regroup(): void {
  recomputeDedupeGroups();
  bumpEventsVersion();
}

const key = (id: string): string => eventKey(SOURCE, id);
const groupOf = (id: number): string => (db.prepare('SELECT dedupe_group AS g FROM events WHERE id = ?').get(id) as { g: string }).g;
const merged = (ids: number[]) => getMergedEvents().filter((m) => m.members.some((x) => ids.includes(x.id)));

test('recomputing groups joins the pairs the model said were one event, and leaves the rest', (t) => {
  useZone(t, 'Australia/Sydney');
  cleanup();
  const a = insert('a', 'Gig at the pub with the Frogs');
  const b = insert('b', 'Tickets: Friday late show');
  const c = insert('c', 'Wholly unrelated', { start_time: local(19, 19), venue_name: 'Elsewhere' });
  try {
    regroup();
    assert.notEqual(groupOf(a), groupOf(b), 'the matcher keeps them apart');
    recordVerdict(key('a'), key('b'), 'h', true, 'Same band, same pub, same night.', 'm');
    regroup();
    assert.equal(groupOf(a), groupOf(b));
    assert.notEqual(groupOf(a), groupOf(c));

    const [event] = merged([a]);
    assert.equal(event.members.length, 2);
    assert.equal(event.mergedBy, 'model');
    assert.equal(event.mergedReason, 'Same band, same pub, same night.');
    assert.equal(merged([c])[0].mergedBy, undefined);

    recordVerdict(key('a'), key('b'), 'h', false, 'No.', 'm');
    regroup();
    assert.notEqual(groupOf(a), groupOf(b), 'a no leaves them apart');
  } finally {
    cleanup();
  }
});

test('an answer about a pair a person grouped by hand does not move anything', (t) => {
  useZone(t, 'Australia/Sydney');
  cleanup();
  const a = insert('a', 'Gig at the pub with the Frogs');
  const b = insert('b', 'Tickets: Friday late show');
  const c = insert('c', 'Friday dinner special');
  try {
    mergeGroups([`solo-${b}`, `solo-${c}`]);
    recordVerdict(key('a'), key('b'), 'h', true, 'Same night.', 'm');
    regroup();
    assert.notEqual(groupOf(a), groupOf(b));
    const events = merged([a, b, c]);
    assert.equal(events.find((e) => e.manual)?.mergedBy, undefined, 'a hand merge is not credited to the model');
  } finally {
    cleanup();
  }
});

test('splitting a joined group sticks: the pair is never joined again, even when its listings change', (t) => {
  useZone(t, 'Australia/Sydney');
  cleanup();
  const a = insert('a', 'Gig at the pub with the Frogs');
  const b = insert('b', 'Tickets: Friday late show');
  try {
    recordVerdict(key('a'), key('b'), 'h', true, 'Same night.', 'm');
    regroup();
    const [event] = merged([a]);
    assert.equal(event.mergedBy, 'model');

    assert.equal(unmergeGroup(event.group).split, 2);
    assert.notEqual(groupOf(a), groupOf(b));
    assert.deepEqual(joinedPairs().filter((p) => p.aKey.startsWith(SOURCE)), []);
    assert.equal(answeredPairs().get(pairId(key('a'), key('b'))), PERSON_HASH);

    db.prepare('UPDATE events SET description = ? WHERE id = ?').run('Changed since', a);
    regroup();
    assert.notEqual(groupOf(a), groupOf(b), 'a regroup does not put them back');
    const listing = (id: number, sourceId: string) => ev({ id, key: key(sourceId), venueName: 'Dupes Test Pub', startTime: local(18, 19) });
    assert.deepEqual(candidatePairs([listing(a, 'a'), listing(b, 'b')], answeredPairs(), NOW), [], 'and it is not asked about again');
  } finally {
    cleanup();
  }
});

test('un-merging a hand merge retracts the model\u2019s earlier yes for those listings', (t) => {
  useZone(t, 'Australia/Sydney');
  cleanup();
  const a = insert('a', 'Gig at the pub with the Frogs');
  const b = insert('b', 'Tickets: Friday late show');
  try {
    recordVerdict(key('a'), key('b'), 'h', true, 'Same night.', 'm');
    const { group } = mergeGroups([`solo-${a}`, `solo-${b}`]);
    unmergeGroup(group);
    regroup();
    assert.notEqual(groupOf(a), groupOf(b));
  } finally {
    cleanup();
  }
});

test('whether the scraped start was a day alone is reported beside it', (t) => {
  useZone(t, 'Australia/Sydney');
  cleanup();
  const midnight = new Date(2031, 2, 18).toISOString();
  const day = insert('day', 'Day only', { date_only: 1, llm_start_time: local(20, 10), start_time: midnight });
  const timed = insert('timed', 'Timed', { date_only: 0, llm_start_time: local(20, 10), start_time: midnight, venue_name: 'Elsewhere' });
  try {
    assert.equal(merged([day])[0].scrapedDateOnly, true);
    const found = merged([timed])[0];
    assert.equal(found.scrapedDateOnly, false, 'a midnight the source really gave is not a day alone');
    assert.ok(found.scrapedStart);
  } finally {
    cleanup();
  }
});

test('forgetting every verdict forgets the pair answers too', () => {
  cleanup();
  const probe = pairId(key('x'), key('y'));
  recordVerdict(key('x'), key('y'), 'h', true, 'r', 'm');
  assert.ok(answeredPairs().has(probe));
  clearEnrichment();
  assert.ok(!answeredPairs().has(probe));
  cleanup();
});
