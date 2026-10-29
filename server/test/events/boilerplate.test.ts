import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanDescription,
  findBoilerplate,
  hostOf,
  isBoilerplate,
  normalizeDescription,
} from '../../src/events/enrich/boilerplate.js';
import { buildDupePrompt } from '../../src/events/enrich/dupePairs.js';
import { loadEvents } from '../../src/events/enrich/dupes.js';
import { pendingEvents } from '../../src/events/enrich/pipeline.js';
import { contentHash } from '../../src/events/enrich/schema.js';
import { db } from '../../src/events/db.js';

/** A site's generic blurb turning up where a description should be. */

const BLURB = 'Find the best Automotive Social Platform And Directory now. Discover the latest posted by Automotive Businesses near you.';
const drive = (n: number, host = 'www.drivernation.com.au') => ({
  url: `https://${host}/events/${n}`,
  title: `All Commodore Night ${n}`,
  description: `All Commodore Night ${n}: ${BLURB}`,
});

test('the same blurb under three listings of a host is boilerplate, with the title taken off', () => {
  const rows = [drive(1), drive(2), drive(3)];
  const found = findBoilerplate(rows);
  assert.equal(found.size, 1);
  assert.ok([...found][0]!.startsWith('drivernation.com.au\nfind the best'));
  for (const r of rows) assert.ok(isBoilerplate(found, r));
  assert.equal(cleanDescription(found, rows[0]!), '');
});

test('two listings are not enough', () => {
  assert.equal(findBoilerplate([drive(1), drive(2)]).size, 0);
});

test('hosts are not pooled, and www. does not make a new host', () => {
  const split = [drive(1), drive(2), drive(3, 'other.example.com')];
  assert.equal(findBoilerplate(split).size, 0);
  const mixed = [drive(1), drive(2, 'drivernation.com.au'), drive(3)];
  assert.equal(findBoilerplate(mixed).size, 1);
});

test('ordinary descriptions are left alone', () => {
  const rows = [1, 2, 3].map((n) => ({
    url: `https://site.example/e/${n}`,
    title: `Show ${n}`,
    description: `A genuinely different description of show number ${n}, with its own details.`,
  }));
  const found = findBoilerplate(rows);
  assert.equal(found.size, 0);
  assert.equal(cleanDescription(found, rows[0]!), rows[0]!.description);
});

test('short repeated text is not boilerplate', () => {
  const rows = [1, 2, 3].map((n) => ({ url: `https://a.example/${n}`, title: `T${n}`, description: 'Free entry, all welcome' }));
  assert.equal(findBoilerplate(rows).size, 0);
});

test('a description with more after the blurb is kept', () => {
  const found = findBoilerplate([drive(1), drive(2), drive(3)]);
  const own = { ...drive(4), description: `${drive(4).description} Gates open at 6pm at the showground.` };
  assert.ok(!isBoilerplate(found, own));
});

test('normalizing strips the title and a colon, dash or bar separator', () => {
  for (const sep of [': ', ' - ', ' | ', ' – ']) {
    assert.equal(normalizeDescription('Big  Show', `big show${sep}Some   TEXT`), 'some text');
  }
  assert.equal(normalizeDescription('Big Show', 'Something else'), 'something else');
  assert.equal(hostOf('not a url'), '');
});

// --- what the model is shown ---

const SOURCE = 'test-boilerplate';

function insert(n: number, over: Record<string, string> = {}): void {
  const row = {
    source: SOURCE, source_id: String(n), title: `All Commodore Night ${n}`, url: drive(n).url,
    description: drive(n).description, start_time: '2099-01-01T08:00:00.000Z', venue_name: 'Test Yard', ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

after(() => { db.prepare('DELETE FROM events WHERE source = ?').run(SOURCE); });

test('the enrichment pass reads a boilerplate listing with no description, and reads it again', () => {
  const mine = () => pendingEvents('m', ['vet'], Number.MAX_SAFE_INTEGER).filter((r) => r.source === SOURCE);
  insert(1); insert(2);
  const before = mine().find((r) => r.title.endsWith(' 1'))!;
  assert.equal(before.description, drive(1).description, 'two rows: nothing found yet');

  insert(3);
  const row = mine().find((r) => r.title.endsWith(' 3'))!;
  assert.equal(row.description, '');
  const input = (description: string) => ({
    title: row.title, description, venueName: row.venue_name, address: '', category: '',
    startTime: row.start_time, source: row.source,
  });
  assert.notEqual(
    contentHash(input(''), 'm', ['vet']),
    contentHash(input(drive(3).description), 'm', ['vet']),
    'an event read with the blurb no longer matches its stored hash'
  );
  // And the stored column is untouched.
  const stored = db.prepare('SELECT description FROM events WHERE source = ? AND source_id = ?').get(SOURCE, '3') as { description: string };
  assert.equal(stored.description, drive(3).description);
});

test('the pair prompt shows the cleaned description', () => {
  db.prepare('DELETE FROM events WHERE source = ?').run(SOURCE);
  insert(1); insert(2); insert(3);
  const mine = loadEvents().filter((e) => e.source === SOURCE);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((e) => e.description === ''));
  const prompt = buildDupePrompt(mine[0]!, mine[1]!);
  assert.ok(!prompt.includes('Automotive Social Platform'));
  assert.ok(prompt.includes('description: (none given)'));
});
