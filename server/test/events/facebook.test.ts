import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEvent, parseEventOg } from '../../src/events/sources/facebook.js';
import { HONEST_HEADERS, BROWSER_HEADERS } from '../../src/events/useragent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The head of https://www.facebook.com/events/921142053782400/ as served to a
// plain request with no cookie, trimmed from 600 KB to the tags that matter.
const LOGGED_OUT = fs.readFileSync(path.join(here, 'fixtures/facebook-event-logged-out.html'), 'utf8');

test('a logged-out event page is read from its link preview when the full parser has nothing', () => {
  const ev = parseEvent(LOGGED_OUT, '921142053782400');
  assert.ok(ev, 'read');
  assert.equal(ev.sourceId, '921142053782400');
  assert.equal(ev.title, 'Bathurst Track Day 2026');
  assert.equal(ev.dateOnly, true, 'a day and no clock time');
  const start = new Date(ev.startTime);
  assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate()], [2026, 10, 25], 'Wednesday, November 25 2026, in local time');
  assert.equal(ev.address, 'Bathurst');
  assert.equal(ev.venueName, 'Mount Panorama Circuit', 'the place the host named, from the path of the link');
  assert.match(ev.description ?? '', /Driving Solutions/);
  assert.equal(ev.imageUrl, 'https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=921142053782400');
  assert.equal(ev.url, 'https://www.facebook.com/events/921142053782400');
  assert.equal(ev.isOnline, false);
});

test('the preview reader copes with the shapes of description Facebook gives', () => {
  const page = (description: string, extra = '') =>
    `<html><head><meta property="og:title" content="Cars &amp; Coffee" /><meta property="og:description" content="${description}" />${extra}</head></html>`;

  const online = parseEventOg(page('Online event by Club on Saturday, December 5 2026'), '1')!;
  assert.equal(online.isOnline, true);
  assert.equal(online.address, '');
  assert.equal(online.title, 'Cars & Coffee', 'entities decoded');

  const timed = parseEventOg(page('Event in Orange by Orange Cars on Sunday, January 3 2027 at 7:30 PM'), '2')!;
  assert.equal(timed.dateOnly, false);
  const at = new Date(timed.startTime);
  assert.deepEqual([at.getHours(), at.getMinutes()], [19, 30]);

  const noTown = parseEventOg(page('Event by Somebody on Friday, March 6 2026'), '3')!;
  assert.equal(noTown.address, '');
  assert.equal(noTown.venueName, '');

  // The path names a town as its place: not a venue.
  const townSlug = parseEventOg(
    page('Event in Bathurst by X on Friday, March 6 2026', '<meta property="og:url" content="https://www.facebook.com/events/bathurst/a-night/1234567890/" />'),
    '4'
  )!;
  assert.equal(townSlug.venueName, '');
});

test('a login wall or a page that is not an event gives nothing', () => {
  const wall = '<html><head><title>Facebook</title><meta property="og:title" content="Facebook" /><meta property="og:description" content="Log in or sign up to view" /></head></html>';
  assert.equal(parseEvent(wall, '9'), null);
  assert.equal(parseEvent('<html><head><title>x</title></head></html>', '9'), null);
  assert.equal(parseEventOg('<meta property="og:title" content="A thing" /><meta property="og:description" content="Nothing about when" />', '9'), null);
});

test('without a cookie the request wears no browser costume', () => {
  assert.match(HONEST_HEADERS['User-Agent'], /^PhotoScout\//);
  assert.ok(!('sec-ch-ua' in HONEST_HEADERS) && !('sec-fetch-site' in HONEST_HEADERS));
  assert.ok('sec-fetch-site' in BROWSER_HEADERS, 'the costume is still there for a signed-in session');
});
