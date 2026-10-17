import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, type EventItem } from '../src/api.js';
import { dateBadge, eventPath, findLinks, findSocials, hostOf, mapLink, openKeyOf, safeHref, timingOf } from '../src/events.js';
import { moreAttendees, MAX_AVATARS, myRsvpOf, nextRsvp, optimisticRsvp, rollbackRsvp, rsvpFromServer, rsvpOptions, rsvpStep, withMe } from '../src/rsvp.js';
import { inviteError, RATE_LIMIT_MESSAGE, shareUrl } from '../src/components/InvitePanel.js';
import { invitePath, inviteWhen } from '../src/components/InvitesInbox.js';
import { countsText } from '../src/components/Rsvp.js';

// Wednesday 9 January 2030, noon, local time.
const NOW = new Date(2030, 0, 9, 12);
const at = (day: number, hour = 10, month = 0) => new Date(2030, month, day, hour).toISOString();

function event(group: string, over: Partial<EventItem> = {}): EventItem {
  return {
    group, title: `Event ${group}`, description: '', startTime: at(10), endTime: null, venueName: '', address: '', locality: '',
    lat: null, lng: null, imageUrl: '', category: '', priceText: '', isOnline: false, dateOnly: false, photoScore: 0,
    series: '', url: '', sources: [], foundAt: null, starred: false, hidden: false, ...over,
  };
}

// --- date labels ---

test('timingOf: ended, happening now, and how far off, by calendar day', () => {
  assert.deepEqual(timingOf(event('a', { startTime: at(8, 10), endTime: at(8, 12) }), NOW), { kind: 'ended', text: 'Ended' });
  assert.equal(timingOf(event('b', { startTime: at(9, 10), endTime: at(9, 14) }), NOW).text, 'Happening now');
  assert.equal(timingOf(event('c', { startTime: at(9, 11) }), NOW).text, 'Happening now', 'no end: taken to run a few hours');
  assert.equal(timingOf(event('d', { startTime: at(9, 6) }), NOW).text, 'Started earlier today', 'no end and long since started');
  assert.equal(timingOf(event('e', { startTime: at(9, 18) }), NOW).text, 'Starts in 6 hours');
  assert.equal(timingOf(event('f', { startTime: new Date(2030, 0, 9, 12, 25).toISOString() }), NOW).text, 'Starts in 25 minutes');
  assert.equal(timingOf(event('g', { startTime: new Date(2030, 0, 9, 13, 0).toISOString() }), NOW).text, 'Starts in 1 hour', 'singular');
  assert.equal(timingOf(event('h', { startTime: at(10, 0) }), NOW).text, 'Starts tomorrow', 'a midnight start is tomorrow, not "in 12 hours"');
  assert.equal(timingOf(event('i', { startTime: at(12, 19) }), NOW).text, 'Starts in 3 days');
  assert.deepEqual(timingOf(event('j', { startTime: at(25, 19) }), NOW), { kind: 'later', text: 'Starts in 16 days' });
  assert.equal(timingOf(event('k', { startTime: 'nonsense' }), NOW).kind, 'unknown');
});

test('timingOf: a day-only event is "today" for the whole day and ended the day after', () => {
  const day = (d: number) => event('x', { dateOnly: true, startTime: at(d, 0) });
  assert.equal(timingOf(day(9), NOW).text, 'Happening today');
  assert.equal(timingOf(day(9), new Date(2030, 0, 9, 23, 30)).kind, 'now');
  assert.equal(timingOf(day(9), new Date(2030, 0, 10, 0, 30)).kind, 'ended');
  assert.equal(timingOf(day(10), NOW).text, 'Starts tomorrow');
});

test('dateBadge: one day, a span in a month, a span over two months', () => {
  assert.equal(dateBadge(event('a', { startTime: at(18) })).day, '18');
  assert.equal(dateBadge(event('a', { startTime: at(18) })).range, false);
  const span = dateBadge(event('b', { dateOnly: true, startTime: at(18, 0), endTime: at(20, 0) }));
  assert.equal(span.day, '18–20');
  assert.equal(span.range, true);
  assert.equal(span.monRange, false);
  const across = dateBadge(event('c', { dateOnly: true, startTime: at(30, 0), endTime: at(2, 0, 1) }));
  assert.equal(across.monRange, true);
  assert.ok(across.mon.includes('–'));
});

// --- links ---

test('hostOf and safeHref: the host without www, and only web addresses become links', () => {
  assert.equal(hostOf('https://www.eventbrite.com.au/e/123'), 'eventbrite.com.au');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('https://a.test/x'), 'https://a.test/x');
  assert.equal(safeHref(null), undefined);
});

test('mapLink: this app\'s map with coordinates, a Google Maps search without, nothing without either', () => {
  const withCoords = mapLink(event('a', { lat: -33.28959, lng: 149.0862 }));
  assert.deepEqual(withCoords, { href: '/?lat=-33.28959&lng=149.08620', internal: true, label: 'Show on the map' });
  const search = mapLink(event('b', { venueName: 'Emus Rugby Club', address: '84 Woodward St, Orange' }));
  assert.equal(search?.internal, false);
  assert.ok(search?.href.startsWith('https://www.google.com/maps/search/?api=1&query='));
  assert.ok(search?.href.includes(encodeURIComponent('Emus Rugby Club, 84 Woodward St, Orange')));
  assert.equal(mapLink(event('c')), null);
  assert.equal(mapLink(event('d', { locality: 'Orange' }))?.internal, false, 'a town alone is still searchable');
});

test('eventPath and openKeyOf: a crawled event and a community event each get their own address, and it reads back', () => {
  assert.equal(eventPath(event('f4457c62')), '/events/f4457c62');
  assert.equal(eventPath(event('a b/c')), '/events/a%20b%2Fc', 'encoded, so it survives as one segment');
  assert.equal(eventPath(event('community:u1', { community: true, communityId: 'u1' })), '/events/c/u1');
  assert.deepEqual(openKeyOf({ group: 'f4457c62' }), { group: 'f4457c62', communityId: null });
  assert.deepEqual(openKeyOf({ id: 'u1' }), { group: 'community:u1', communityId: 'u1' });
  assert.equal(openKeyOf({}), null);
});

test('findLinks and findSocials: links from the description, the listing left out, organisers by handle', () => {
  const ev = event('a', {
    url: 'https://www.eventbrite.com.au/e/123',
    description: 'Details at https://club.example/night, follow https://instagram.com/emusrugby/ or https://www.facebook.com/events/999. Also javascript:x',
  });
  assert.deepEqual(findLinks(ev).map((l) => l.host), ['club.example', 'instagram.com', 'facebook.com']);
  const socials = findSocials(ev);
  assert.deepEqual(socials.map((s) => `${s.network}:${s.handle}`), ['Instagram:emusrugby'], 'a facebook /events/ link names the event, not the organiser');
  assert.deepEqual(findSocials(event('b')), []);
  assert.deepEqual(findLinks(event('c', { url: 'javascript:alert(1)' })), []);
});

// --- RSVP ---

test('rsvpOptions and myRsvpOf: a community event only offers Going, and reads the old isGoing', () => {
  assert.deepEqual(rsvpOptions(event('a')), ['going', 'interested']);
  assert.deepEqual(rsvpOptions(event('b', { community: true })), ['going']);
  assert.equal(myRsvpOf(event('a', { myRsvp: 'interested' })), 'interested');
  assert.equal(myRsvpOf(event('a')), null);
  assert.equal(myRsvpOf(event('b', { community: true, isGoing: true })), 'going');
  assert.equal(myRsvpOf(event('b', { community: true, isGoing: true, myRsvp: null })), null, 'the explicit answer wins');
});

test('nextRsvp: pressing the answer you gave takes it back', () => {
  assert.equal(nextRsvp(null, 'going'), 'going');
  assert.equal(nextRsvp('going', 'going'), null);
  assert.equal(nextRsvp('going', 'interested'), 'interested');
});

test('optimisticRsvp: counts move across when the answer changes, and never go below zero', () => {
  const base = event('a', { going: 5, interested: 2, myRsvp: null });
  assert.deepEqual(optimisticRsvp(base, 'going'), { going: 6, interested: 2, myRsvp: 'going', isGoing: true });
  assert.deepEqual(optimisticRsvp(base, 'interested'), { going: 5, interested: 3, myRsvp: 'interested', isGoing: false });
  const going = event('a', { going: 6, interested: 2, myRsvp: 'going' });
  assert.deepEqual(optimisticRsvp(going, 'interested'), { going: 5, interested: 3, myRsvp: 'interested', isGoing: false });
  assert.deepEqual(optimisticRsvp(going, null), { going: 5, interested: 2, myRsvp: null, isGoing: false });
  const stale = event('a', { going: 0, interested: 0, myRsvp: 'going' });
  assert.equal(optimisticRsvp(stale, null).going, 0, 'a count that was behind is clamped');
  assert.deepEqual(optimisticRsvp(event('b'), 'going'), { going: 1, interested: 0, myRsvp: 'going', isGoing: true }, 'missing counts are zero');
});

test('optimisticRsvp: a community event cannot become interested', () => {
  const c = event('community:u', { community: true, going: 3, interested: 0, myRsvp: 'going', isGoing: true });
  assert.deepEqual(optimisticRsvp(c, 'interested'), { going: 3, interested: 0, myRsvp: 'going', isGoing: true }, 'left as it was');
  assert.deepEqual(optimisticRsvp(c, null), { going: 2, interested: 0, myRsvp: null, isGoing: false });
});

test('rollback: a refused answer takes back its own steps and the answer it replaced', () => {
  const before = event('a', { going: 5, interested: 2, myRsvp: 'interested' });
  const guess = optimisticRsvp(before, 'going');
  const moved = { ...before, ...guess };
  assert.notEqual(moved.going, before.going);
  const back = rollbackRsvp(moved, rsvpStep(before, guess), guess.myRsvp, myRsvpOf(before));
  assert.deepEqual([back.going, back.interested, back.myRsvp, back.isGoing], [5, 2, 'interested', false]);
});

test('rollback: what a refresh has since changed is kept, and a refresh that replaced the guess is left as it is', () => {
  const before = event('a', { going: 5, interested: 2, myRsvp: null });
  const guess = optimisticRsvp(before, 'going');
  const step = rsvpStep(before, guess);
  // Two more went in on a refresh that still shows the guess: they stay.
  const moved = { ...before, ...guess, going: (guess.going ?? 0) + 2 };
  const back = rollbackRsvp(moved, step, guess.myRsvp, null);
  assert.deepEqual([back.going, back.myRsvp], [(before.going ?? 0) + 2, null]);
  // A refresh that replaced the guess already has the server's counts, which never held it.
  const replaced = event('a', { going: 6, interested: 2, myRsvp: null });
  assert.equal(rollbackRsvp(replaced, step, guess.myRsvp, null), replaced);
});

test('rsvpFromServer: the server\'s counts replace the guess', () => {
  assert.deepEqual(rsvpFromServer({ going: 9, interested: 1, mine: 'going' }), { going: 9, interested: 1, myRsvp: 'going', isGoing: true });
  assert.deepEqual(rsvpFromServer({ going: 9, interested: 1, mine: null }), { going: 9, interested: 1, myRsvp: null, isGoing: false });
});

test('withMe and moreAttendees: your face goes first at once, and "+N more" counts who is hidden', () => {
  const people = [{ id: 'a', username: 'ann', avatar: '' }, { id: 'b', username: 'bob', avatar: '' }];
  const me = { id: 'm', username: 'me', avatar: 'x.png' };
  assert.deepEqual(withMe(people, me, true).map((p) => p.id), ['m', 'a', 'b']);
  assert.deepEqual(withMe([...people, { id: 'm', username: 'me', avatar: 'x.png' }], me, true).map((p) => p.id), ['m', 'a', 'b'], 'not twice');
  assert.deepEqual(withMe([...people, { id: 'm', username: 'me', avatar: '' }], me, false).map((p) => p.id), ['a', 'b']);
  assert.equal(MAX_AVATARS, 12);
  assert.equal(moreAttendees(30, 12), 18);
  assert.equal(moreAttendees(12, 12), 0);
  assert.equal(moreAttendees(3, 12), 0);
});

test('countsText: what is zero is left out, and a community event has no "interested"', () => {
  assert.equal(countsText(event('a', { going: 12, interested: 4 })), '12 going · 4 interested');
  assert.equal(countsText(event('a', { going: 0, interested: 4 })), '4 interested');
  assert.equal(countsText(event('a')), '');
  assert.equal(countsText(event('b', { community: true, going: 2, interested: 5 })), '2 going');
});

// --- invites ---

test('inviteError: the rate limit has its own words, anything else says what the server said', () => {
  assert.equal(inviteError(new HttpError('Too many', 429)), RATE_LIMIT_MESSAGE);
  assert.ok(RATE_LIMIT_MESSAGE.startsWith("You've sent a lot of invites"));
  assert.equal(inviteError(new HttpError('No such user', 404)), 'No such user');
  assert.equal(inviteError(new Error('')), 'Could not send the invite');
});

test('shareUrl and invitePath: both point at the same address for the same event', () => {
  assert.equal(shareUrl(event('abc'), 'https://ps.example'), 'https://ps.example/events/abc');
  assert.equal(shareUrl(event('community:u1', { community: true, communityId: 'u1' }), 'https://ps.example'), 'https://ps.example/events/c/u1');
  assert.equal(invitePath({ kind: 'event', ref: 'abc' }), '/events/abc');
  assert.equal(invitePath({ kind: 'community', ref: 'u1' }), '/events/c/u1');
});

test('inviteWhen: the viewer\'s own clock, and nothing for a date that is not one', () => {
  const text = inviteWhen(at(18, 19));
  assert.ok(text.includes('·'));
  assert.ok(text.includes('18'));
  assert.equal(inviteWhen(''), '');
  assert.equal(inviteWhen(null), '');
});
