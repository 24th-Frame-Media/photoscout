import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkWhen, hidesEvent, normalizeQuote, quotedFrom, statusReason } from '../../src/events/enrich/when.js';
import {
  buildPrompt,
  buildSchema,
  ENRICH_JOBS,
  PROMPT_VERSION,
  readVerdict,
  type EnrichInput,
} from '../../src/events/enrich/schema.js';
import { chooseFields } from '../../src/events/merge.js';
import type { EventRow } from '../../src/events/merge.js';
import { db } from '../../src/events/db.js';
import { clearEnrichment } from '../../src/events/enrich/pipeline.js';
import { DEFAULT_SETTINGS } from '../../src/events/sources/types.js';
import { useZone } from './zone.js';

/**
 * The date check: what the schema asks, what is believed of the answer, and
 * which of the opinions about a start is the one shown.
 */

// Tuesday 20 October 2026, noon local.
const NOW = new Date(2026, 9, 20, 12);
const local = (y: number, mo: number, d: number, h = 0, mi = 0): string => new Date(y, mo - 1, d, h, mi).toISOString();

const TEXT = {
  title: 'Cars and Coffee',
  description: 'Join us on Saturday 15 November 2026 from 8am at the showground.\nTickets on sale 1 November. SOLD OUT again, thanks everyone!',
  firstSeen: local(2026, 10, 19),
  // What the source gave: a week early.
  startTime: local(2026, 11, 8, 8),
};

const RIGHT = {
  whenSource: 'Saturday 15 November 2026 from 8am',
  whenVerdict: 'wrong',
  start: '2026-11-15 08:00',
  end: null,
  status: 'scheduled',
  statusSource: null,
};

test('a correct correction is accepted, with the words it came from', (t) => {
  useZone(t, 'Australia/Sydney');
  const out = checkWhen(RIGHT, TEXT, NOW);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.correction, {
    startTime: local(2026, 11, 15, 8),
    endTime: '',
    dateOnly: false,
    note: 'Saturday 15 November 2026 from 8am',
    dropped: [],
  });
});

test('the quotation may differ in case, spacing and curly punctuation', (t) => {
  useZone(t, 'Australia/Sydney');
  const out = checkWhen({ ...RIGHT, whenSource: 'saturday  15 NOVEMBER 2026\nfrom 8am' }, TEXT, NOW);
  assert.ok(out.correction);
  assert.equal(normalizeQuote('It’s “this” – now'), 'it\'s "this" - now');
  assert.ok(quotedFrom('  ', 'anything') === false, 'an empty quotation proves nothing');
});

test('a date with no time is a day alone, and a missing year is the next one after first seen', (t) => {
  useZone(t, 'Australia/Sydney');
  const text = { ...TEXT, description: 'Our big day is on Saturday 15 November.' };
  const out = checkWhen({ ...RIGHT, whenSource: 'Saturday 15 November', start: '2026-11-15' }, text, NOW);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.correction?.dateOnly, true);
  assert.equal(out.correction?.startTime, local(2026, 11, 15));
});

test('a time the quotation does not state is dropped, and the day kept', (t) => {
  useZone(t, 'Australia/Sydney');
  const text = { ...TEXT, description: 'Our big day is Saturday 25 October 2026. See you there.' };
  const out = checkWhen(
    { ...RIGHT, whenSource: 'Saturday 25 October', start: '2026-10-25 19:00', end: '2026-10-26 22:00' },
    text,
    NOW
  );
  assert.equal(out.correction?.dateOnly, true);
  assert.equal(out.correction?.startTime, local(2026, 10, 25));
  assert.equal(out.correction?.endTime, local(2026, 10, 27), 'the end is the close of its day');
  assert.match(out.rejected.join(), /time dropped/);
  assert.match(out.rejected.join(), /end time dropped/);

  const read = readVerdict(
    { ...RIGHT, whenSource: 'Saturday 25 October', start: '2026-10-25 19:00' },
    ['when'],
    { ...INPUT, description: text.description },
    NOW
  );
  assert.equal(read.dateOnly, true);
});

test('the correction is thrown away when the quotation is not in the listing', (t) => {
  useZone(t, 'Australia/Sydney');
  const out = checkWhen({ ...RIGHT, whenSource: 'Saturday 22 November 2026 from 8am', start: '2026-11-22 08:00' }, TEXT, NOW);
  assert.equal(out.correction, undefined);
  assert.match(out.rejected.join(), /not in the listing/);
});

test('the correction is thrown away when the app reads the quotation as another day or time', (t) => {
  useZone(t, 'Australia/Sydney');
  const day = checkWhen({ ...RIGHT, start: '2026-11-16 08:00' }, TEXT, NOW);
  assert.equal(day.correction, undefined);
  assert.match(day.rejected.join(), /different day/);

  const time = checkWhen({ ...RIGHT, start: '2026-11-15 09:30' }, TEXT, NOW);
  assert.equal(time.correction, undefined);
  assert.match(time.rejected.join(), /different time/);

  const vague = checkWhen({ ...RIGHT, whenSource: 'Join us on', start: '2026-11-15 08:00' }, TEXT, NOW);
  assert.match(vague.rejected.join(), /does not read as a date/);
});

test('only a verdict of wrong changes anything', (t) => {
  useZone(t, 'Australia/Sydney');
  for (const whenVerdict of ['matches', 'unclear', undefined]) {
    const out = checkWhen({ ...RIGHT, whenVerdict }, TEXT, NOW);
    assert.equal(out.correction, undefined);
    assert.deepEqual(out.rejected, []);
  }
});

test('a start more than a day ago, or more than 400 days ahead, is thrown away', (t) => {
  useZone(t, 'Australia/Sydney');
  const past = checkWhen(
    { ...RIGHT, whenSource: '14 October 2026', start: '2026-10-14' },
    { ...TEXT, description: 'Held on 14 October 2026.', firstSeen: local(2026, 9, 1) },
    NOW
  );
  assert.equal(past.correction, undefined);
  assert.match(past.rejected.join(), /out of range/);

  const far = checkWhen(
    { ...RIGHT, whenSource: '15 November 2028', start: '2028-11-15' },
    { ...TEXT, description: 'Back on 15 November 2028.' },
    NOW
  );
  assert.equal(far.correction, undefined);
  assert.match(far.rejected.join(), /out of range/);

  // Yesterday evening is within the day of grace.
  const recent = checkWhen(
    { ...RIGHT, whenSource: '19 October 2026 at 7pm', start: '2026-10-19 19:00' },
    { ...TEXT, description: 'Running on 19 October 2026 at 7pm.', firstSeen: local(2026, 10, 1) },
    NOW
  );
  assert.ok(recent.correction);
});

test('a "correction" to the time already shown is not one, and nonsense is not a date', (t) => {
  useZone(t, 'Australia/Sydney');
  const same = checkWhen(RIGHT, { ...TEXT, startTime: local(2026, 11, 15, 8) }, NOW);
  assert.equal(same.correction, undefined);
  assert.match(same.rejected.join(), /already shown/);

  for (const start of ['2026-02-30 08:00', '2026-11-15 25:00', 'next Saturday', '', null, 12]) {
    assert.equal(checkWhen({ ...RIGHT, start }, TEXT, NOW).correction, undefined, String(start));
  }
});

test('an end is kept only as a believable run from the start', (t) => {
  useZone(t, 'Australia/Sydney');
  assert.equal(checkWhen({ ...RIGHT, end: '2026-11-15 13:00' }, TEXT, NOW).correction?.endTime, local(2026, 11, 15, 13));
  assert.equal(checkWhen({ ...RIGHT, end: '2026-11-16' }, TEXT, NOW).correction?.endTime, local(2026, 11, 17), 'a bare date closes its day');
  assert.equal(checkWhen({ ...RIGHT, end: '2026-11-15 07:00' }, TEXT, NOW).correction?.endTime, '', 'before the start');
  assert.equal(checkWhen({ ...RIGHT, end: '2027-03-01' }, TEXT, NOW).correction?.endTime, '', 'a season, not an event');
  assert.ok(checkWhen({ ...RIGHT, end: 'late' }, TEXT, NOW).correction, 'a bad end costs only the end');
});

test('cancelled, postponed and sold out need their words to be in the listing', () => {
  const soldOut = checkWhen({ whenVerdict: 'unclear', status: 'sold_out', statusSource: 'sold out again' }, TEXT, NOW);
  assert.deepEqual(soldOut.status, { status: 'sold_out', note: 'sold out again' });

  const invented = checkWhen({ whenVerdict: 'unclear', status: 'cancelled', statusSource: 'This event has been cancelled' }, TEXT, NOW);
  assert.equal(invented.status, undefined);
  assert.match(invented.rejected.join(), /cancelled ignored/);

  const none = checkWhen({ whenVerdict: 'unclear', status: 'postponed', statusSource: null }, TEXT, NOW);
  assert.equal(none.status, undefined);
  assert.equal(checkWhen({ whenVerdict: 'unclear', status: 'scheduled', statusSource: null }, TEXT, NOW).status, undefined);
});

test('only cancelled and postponed take an event off the list', () => {
  assert.deepEqual(['scheduled', 'cancelled', 'postponed', 'sold_out', ''].map(hidesEvent), [false, true, true, false, false]);
  assert.equal(statusReason('cancelled', 'Event cancelled'), 'Cancelled — “Event cancelled”');
  assert.equal(statusReason('postponed', ''), 'Postponed');
});

// --- the schema and the prompt ---

const INPUT: EnrichInput = {
  title: TEXT.title, description: TEXT.description, venueName: '', address: '', category: '',
  startTime: TEXT.startTime, source: 'x', firstSeen: TEXT.firstSeen,
};

test('the schema carries the date fields only when the job is on', () => {
  const on = buildSchema(['when']);
  assert.deepEqual(Object.keys(on.properties as object).sort(), ['end', 'start', 'status', 'statusSource', 'whenSource', 'whenVerdict']);
  assert.deepEqual((on.required as string[]).sort(), Object.keys(on.properties as object).sort());
  const props = on.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.whenVerdict.enum, ['matches', 'wrong', 'unclear']);
  assert.deepEqual(props.status.enum, ['scheduled', 'cancelled', 'postponed', 'sold_out']);

  const off = buildSchema(['vet', 'describe', 'rename', 'classify', 'extract', 'score'], INPUT).properties as object;
  for (const key of ['whenSource', 'whenVerdict', 'start', 'end', 'status', 'statusSource']) assert.ok(!(key in off), key);
  assert.ok(ENRICH_JOBS.some((j) => j.key === 'when' && j.label === 'Check dates'));
  assert.ok(DEFAULT_SETTINGS.llmJobs.includes('when'));
});

test('the prompt asks about dates, and gives first-seen, only when the job is on', () => {
  const on = buildPrompt(INPUT, ['when']);
  assert.match(on, /whenSource/);
  assert.match(on, /first seen: /);
  const off = buildPrompt(INPUT, ['score']);
  assert.doesNotMatch(off, /whenSource|first seen/);
  assert.ok(PROMPT_VERSION >= 6, 'bumped so events already read are read again');
});

test('readVerdict applies the guard, and ignores the fields when the job is off', (t) => {
  useZone(t, 'Australia/Sydney');
  const read = readVerdict(RIGHT, ['when'], INPUT, NOW);
  assert.equal(read.startTime, local(2026, 11, 15, 8));
  assert.equal(read.whenNote, RIGHT.whenSource);
  assert.equal(read.dateOnly, false);

  const bad = readVerdict({ ...RIGHT, whenSource: 'made up' }, ['when'], INPUT, NOW);
  assert.equal(bad.startTime, undefined);
  assert.ok(bad.whenRejected?.length);

  assert.deepEqual(readVerdict(RIGHT, ['score'], INPUT, NOW), {});
  assert.deepEqual(readVerdict(RIGHT, ['when'], undefined, NOW), {}, 'nothing to check a quotation against');
});

// --- which opinion is shown ---

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1, source: 'midnightspec', source_id: 'x1', title: 'Cars and Coffee', description: '',
    start_time: TEXT.startTime, end_time: '2026-11-08T12:00:00.000Z', venue_name: '', address: '',
    lat: null, lng: null, url: 'https://example.test/1', image_url: '', category: 'Cars & bikes',
    price_text: '', is_online: 0, date_only: 0, photo_score: 50, archived: 0, archived_at: null,
    starred: 0, hidden: 0, dedupe_group: 'g1', manual_group: '', manual_parent: 0, first_seen_at: null,
    llm_description: '', llm_title: '', llm_vet_note: '', llm_vetted_at: '', llm_category: '',
    llm_venue_name: '', llm_address: '', llm_price_text: '', llm_photo_score: null,
    llm_start_time: '', llm_end_time: '', llm_date_only: null, llm_when_note: '', llm_status: '', llm_status_note: '',
    vision_venue_name: '', vision_address: '', vision_price_text: '', vision_note: '',
    edit_title: '', edit_description: '', edit_start_time: '', edit_venue_name: '', edit_address: '',
    edit_category: '', edit_price_text: '', edit_image_url: '', edit_photo_score: null,
    ...over,
  };
}

const FIXED = {
  llm_start_time: local(2026, 11, 15, 8), llm_end_time: '', llm_date_only: 0, llm_when_note: 'Saturday 15 November 2026 from 8am',
};

test('a start typed by hand beats the model\'s, which beats the scraped one', () => {
  const scraped = chooseFields([row()]);
  assert.equal(scraped.startTime, '');
  assert.equal(scraped.modelStart, null);
  assert.equal(scraped.enriched.startTime, undefined);

  const model = chooseFields([row(FIXED)]);
  assert.equal(model.startTime, FIXED.llm_start_time);
  assert.equal(model.enriched.startTime, 'model');
  assert.deepEqual(model.modelStart, { endTime: '', dateOnly: false, note: FIXED.llm_when_note });

  const typed = chooseFields([row({ ...FIXED, edit_start_time: local(2026, 11, 8, 8) })]);
  assert.equal(typed.startTime, local(2026, 11, 8, 8));
  assert.equal(typed.enriched.startTime, undefined, 'a person\'s time is not badged as a machine\'s');
  assert.equal(typed.modelStart, null);
  assert.ok(typed.edited.includes('startTime'));
});

test('a start edited as a bare day stays a day; a timed edit is unaffected', (t) => {
  useZone(t, 'Australia/Sydney');
  const day = chooseFields([row({ ...FIXED, edit_start_time: '2026-11-08' })]);
  assert.equal(day.startTime, local(2026, 11, 8));
  assert.equal(day.startDateOnly, true);
  assert.equal(day.modelStart, null, "a person's day still beats the model's");
  assert.ok(day.edited.includes('startTime'));

  const timed = chooseFields([row({ edit_start_time: local(2026, 11, 8, 0) })]);
  assert.equal(timed.startTime, local(2026, 11, 8, 0));
  assert.equal(timed.startDateOnly, false, 'an edited midnight is a time, not a day');
  assert.equal(chooseFields([row()]).startDateOnly, false);
});

test('a status is reported from any listing, with its words', () => {
  assert.equal(chooseFields([row()]).status, null);
  assert.deepEqual(
    chooseFields([row({ id: 1 }), row({ id: 2, llm_status: 'cancelled', llm_status_note: 'cancelled' })]).status,
    { status: 'cancelled', note: 'cancelled' }
  );
  assert.equal(
    chooseFields([row({ llm_status: 'sold_out' }), row({ id: 2, llm_status: 'postponed' })]).status?.status,
    'postponed',
    'a hiding status outranks a label'
  );
});

// --- the database ---

test('the new columns exist, and clearing the verdicts resets them', () => {
  const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['llm_start_time', 'llm_end_time', 'llm_date_only', 'llm_when_note', 'llm_status', 'llm_status_note']) {
    assert.ok(cols.includes(col), col);
  }

  const id = Number(
    db.prepare(
      `INSERT INTO events (source, source_id, title, start_time, llm_start_time, llm_end_time, llm_date_only,
                           llm_when_note, llm_status, llm_status_note)
       VALUES ('test-when', 'a', 'x', '2026-11-08T00:00:00.000Z', '2026-11-15T00:00:00.000Z', '2026-11-16T00:00:00.000Z', 1,
               'quote', 'cancelled', 'quote')`
    ).run().lastInsertRowid
  );
  try {
    clearEnrichment();
    const after = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow;
    assert.equal(after.llm_start_time, '');
    assert.equal(after.llm_end_time, '');
    assert.equal(after.llm_date_only, null);
    assert.equal(after.llm_when_note, '');
    assert.equal(after.llm_status, '');
    assert.equal(after.llm_status_note, '');
  } finally {
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }
});
