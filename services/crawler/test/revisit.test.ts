import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterRead, afterVerdict, baseHours, dueAt, HOUR_MS, intervalHours, MAX_INTERVAL_HOURS, pageKind, parseVerdicts, plan,
  PRIOR_WEIGHT, SEED_INTERVAL_HOURS, Standing,
} from '../src/revisit.js';

const FRESH_PAGE: Standing = { yield: 0, emptyReads: 0 };

test('a productive page is read every 6 to 12 hours, a poor one daily or less', () => {
  assert.equal(baseHours(3), 6);
  assert.equal(baseHours(1.2), 9);
  assert.equal(baseHours(0.5), 12);
  assert.equal(baseHours(0.2), 24);
  assert.equal(baseHours(0), 48);
  for (const y of [0.5, 1, 2, 5]) assert.ok(intervalHours(y, 0) <= 12, `yield ${y}`);
});

test('every empty read doubles the wait, up to 30 days', () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => intervalHours(2, n)), [6, 12, 24, 48]);
  assert.equal(intervalHours(2, 20), MAX_INTERVAL_HOURS);
  assert.equal(MAX_INTERVAL_HOURS, 720);
  assert.equal(intervalHours(0.5, 99), MAX_INTERVAL_HOURS, 'a silly count is clamped, not overflowed');
});

test('reads that find new events raise the yield and clear the empty count; reads that do not, lower it', () => {
  let s = afterRead(FRESH_PAGE, 3);
  assert.ok(Math.abs(s.yield - 0.35 * PRIOR_WEIGHT * 3) < 1e-9);
  assert.equal(s.emptyReads, 0);
  const risen = s.yield;
  s = afterRead(s, 0);
  assert.ok(s.yield < risen);
  assert.equal(s.emptyReads, 1);
  s = afterRead(s, 0);
  assert.equal(s.emptyReads, 2);
  assert.equal(afterRead(s, 1).emptyReads, 0, 'one new event brings it back to its base cadence');
  // A huge calendar does not count for more than a handful.
  assert.equal(afterRead(FRESH_PAGE, 500).yield, afterRead(FRESH_PAGE, 5).yield);
});

test('a page that keeps finding good events is read often, and waits longer each time it comes up empty', () => {
  let s: Standing = FRESH_PAGE;
  for (let i = 0; i < 6; i++) s = afterVerdict(afterRead(s, 2), 2, 0);
  const busy = plan('page', s).hours as number;
  assert.ok(busy <= 9, `productive: ${busy} h`);

  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    s = afterRead(s, 0);
    waits.push(plan('page', s).hours as number);
  }
  assert.ok(waits[0] > busy, 'the first empty read already waits longer');
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] > waits[i - 1], 'each empty read waits longer');
});

test('an ordinary page that has never been worth anything is not read again; a once-good one fades out', () => {
  // The first read found nothing: as the crawler has always done, it is left alone.
  assert.equal(plan('page', afterRead(FRESH_PAGE, 0)).hours, null);
  // One that found events then dried up is read again, later each time, then let go.
  let s = afterRead(FRESH_PAGE, 4);
  const waits: (number | null)[] = [plan('page', s).hours];
  for (let i = 0; i < 40 && waits.at(-1) !== null; i++) {
    s = afterRead(s, 0);
    waits.push(plan('page', s).hours);
  }
  assert.equal(waits.at(-1), null, 'dropped in the end');
  const numeric = waits.filter((w): w is number => w !== null);
  assert.equal(Math.max(...numeric), MAX_INTERVAL_HOURS, 'after reaching the 30 day cap');
  assert.ok(waits.length <= 12, `${waits.length} reads`);
});

test('an account gets the cap in chances; a post and a pinned page are special cases', () => {
  let s: Standing = { yield: 0.5, emptyReads: 0 };
  let reads = 0;
  while (plan('profile', s).hours !== null && reads < 50) {
    s = afterRead(s, 0);
    reads++;
  }
  assert.ok(reads > 3 && reads < 20, `${reads} reads before an account that gives nothing is dropped`);
  assert.equal(plan('oneshot', { yield: 9, emptyReads: 0 }).hours, null, 'a post is read once');
  assert.equal(plan('seed', { yield: 0, emptyReads: 30 }).hours, SEED_INTERVAL_HOURS, 'a pinned page keeps its cadence');
});

test('the due time is counted from the read', () => {
  const at = Date.UTC(2026, 9, 1, 0, 0, 0);
  assert.equal(dueAt('page', { yield: 3, emptyReads: 0 }, at), new Date(at + 6 * HOUR_MS).toISOString());
  assert.equal(dueAt('oneshot', { yield: 3, emptyReads: 0 }, at), null);
});

test('verdicts: good ones add to the guess, bad ones take it back, and none move a page with nothing new', () => {
  const read = afterRead(FRESH_PAGE, 2);
  const praised = afterVerdict(read, 2, 0);
  assert.ok(praised.yield > read.yield + 0.5, 'two good events weigh more than the crawler guess');
  const panned = afterVerdict(read, 0, 2);
  assert.ok(panned.yield < read.yield, 'two culled events cancel the guess');
  assert.ok(panned.yield >= 0);
  assert.deepEqual(afterVerdict(read, 0, 0), read);
  assert.equal(afterVerdict({ yield: 0.1, emptyReads: 5 }, 1, 0).emptyReads, 0, 'good news ends the back-off');
  assert.equal(afterVerdict({ yield: 0.1, emptyReads: 5 }, 0, 3).emptyReads, 5, 'bad news leaves it');
  // A flyer counts for more: the app sends 1.5 for one.
  assert.ok(afterVerdict(read, 1.5, 0).yield > afterVerdict(read, 1, 0).yield);
});

test('a URL is classed by how it is revisited', () => {
  assert.equal(pageKind('https://example.com/whats-on', false), 'page');
  assert.equal(pageKind('https://example.com/whats-on', true), 'seed');
  assert.equal(pageKind('https://www.instagram.com/p/Dc3ABIxk-Oj/', false), 'oneshot');
  assert.equal(pageKind('https://www.instagram.com/mqautomotivesociety/', false), 'profile');
  assert.equal(pageKind('https://www.facebook.com/somepage/', false), 'profile');
  assert.equal(pageKind('https://www.facebook.com/events/921142053782400/', false), 'oneshot');
});

test('the verdicts body is read leniently', () => {
  assert.deepEqual(
    parseVerdicts([{ foundOn: 'https://a.example/x', good: 2, bad: 1 }, null, { good: 1 }, { foundOn: 'https://b.example', good: 'x' }]),
    [{ foundOn: 'https://a.example/x', good: 2, bad: 1 }]
  );
  assert.deepEqual(parseVerdicts({ nope: 1 }), []);
  assert.equal(parseVerdicts([{ foundOn: 'https://a.example', good: 1 }])[0].bad, 0);
});

test('the store: verdicts are totals, so sending one twice counts once, and a post speaks for its account', async () => {
  process.env.CRAWLER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-revisit-'));
  const store = await import('../src/store.js');

  const profile = 'https://www.instagram.com/clubcars/';
  const post = 'https://www.instagram.com/p/AbCdEfGhIj/';
  const page = 'https://events.example.com/whats-on';
  store.offer(profile, 0, 8);
  store.offer(post, 0, 15, profile);
  store.offer(page, 0, 5);
  const row = (url: string) => store.pageList('reads', 200).find((p) => p.url === url)!;

  store.markDone(profile, 0, '12 recent posts', 0);
  const first = row(profile);
  assert.equal(first.emptyReads, 1, 'an account read holds no event itself');
  assert.ok(first.nextDue, 'but is still due again');

  store.markDone(post, 1, '', 1);
  const afterPost = row(profile);
  assert.equal(afterPost.emptyReads, 0, 'its post held an event');
  assert.ok(afterPost.yield > first.yield);
  assert.equal(row(post).nextDue, null, 'a post is read once');

  store.markDone(page, 3, '', 3);
  const read = row(page);

  assert.equal(store.applyVerdicts([{ foundOn: post, good: 1.5, bad: 0 }, { foundOn: 'https://unknown.example/', good: 1, bad: 0 }]), 1);
  const once = row(profile);
  assert.ok(once.yield > afterPost.yield + 0.3, 'the post being good raised the account');
  store.applyVerdicts([{ foundOn: post, good: 1.5, bad: 0 }]);
  assert.equal(row(profile).yield, once.yield, 'the same verdict again changes nothing');

  store.applyVerdicts([{ foundOn: page, good: 0, bad: 3 }]);
  const panned = row(page);
  assert.ok(panned.yield < read.yield, 'three culled events lowered the page');
  assert.equal(panned.bad, 3);

  // Nothing is due yet, and a failed read of a page that has delivered is another empty one.
  assert.equal(store.requeueDue(100), 0);
  store.markFailed(page, 'HTTP 503');
  assert.equal(row(page).state, 'failed');
  assert.ok(row(page).emptyReads > read.emptyReads);
});
