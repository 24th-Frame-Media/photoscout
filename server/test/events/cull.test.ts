import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cullable, cullReason, detectNotAnEvent, localSites, regionsNamedIn, siteOf, titleDateMismatch, vetting } from '../../src/events/cull.js';

const bathurst = { name: 'Bathurst', lat: -33.4166, lng: 149.5804, radiusKm: 85 };
const penrith = { name: 'Penrith', lat: -33.751, lng: 150.694, radiusKm: 25 };
const hubs = [bathurst, penrith];
const ON = { cullOutsideAreas: true, excludedCategories: ['Music'] };

function ev(over: Partial<Cullable> = {}): Cullable {
  return {
    lat: null, lng: null, locality: '', area: '', category: 'Motorsport',
    starred: false, unknownLocation: false, sources: [{ source: 'crawler' }], edited: [],
    ...over,
  };
}

const bathurstTown = { lat: -33.42, lng: 149.58 };
// Melbourne: a long way from both.
const melbourne = { lat: -37.8136, lng: 144.9631 };

test('an event far outside every area is culled, and says how far', () => {
  assert.match(cullReason(ev(melbourne), hubs, ON) ?? '', /^\d+ km from Bathurst, the nearest area$/);
});

test('nothing is culled for distance with the setting off', () => {
  assert.equal(cullReason(ev(melbourne), hubs, { cullOutsideAreas: false }), null);
});

test('just over a radius is still in the area', () => {
  // About 100 km west of Bathurst: over 85, under 85 x 1.5.
  assert.equal(cullReason(ev({ lat: -33.42, lng: 148.5 }), hubs, ON), null);
});

test('an event that rounds to one of the towns is in it', () => {
  assert.equal(cullReason(ev({ ...melbourne, area: 'Bathurst' }), hubs, ON), null);
});

test('a town with no coordinates of its own is placed by its last lookup', () => {
  const where = (name: string) => (name === 'Geelong' ? [{ lat: -38.15, lng: 144.36 }] : []);
  assert.ok(cullReason(ev({ locality: 'Geelong' }), hubs, ON, where));
  assert.equal(cullReason(ev({ locality: 'Nowhere' }), hubs, ON, where), 'Place not found, so not known to be in any area');
});

test('a town name that also exists inside an area is given the benefit of it', () => {
  // Kelso, Scotland first, as Nominatim may well rank it; Kelso NSW second.
  const kelso = () => [{ lat: 55.598, lng: -2.433 }, { lat: -33.418, lng: 149.614 }];
  assert.equal(cullReason(ev({ locality: 'Kelso' }), hubs, ON, kelso), null);
});

test('an event nothing can place is culled, unless something else says it is local', () => {
  const nowhere = { unknownLocation: true };
  assert.equal(cullReason(ev(nowhere), hubs, ON), 'No place given, so not known to be in any area');
  assert.equal(cullReason(ev(nowhere), hubs, { cullOutsideAreas: false }), null, 'only with the setting on');
  assert.equal(cullReason(ev({ ...nowhere, sources: [{ source: 'ical' }] }), hubs, ON), null, 'a feed set up for the area');
  assert.equal(cullReason(ev({ ...nowhere, title: '2027 Bathurst 12 Hour' }), hubs, ON), null, 'the title names an area');
  assert.ok(cullReason(ev({ ...nowhere, title: 'Bathurstian Society Webinar' }), hubs, ON), 'a whole word, not a fragment');
  assert.equal(cullReason(ev({ ...nowhere, localSite: true }), hubs, ON), null, 'a site that publishes for the area');
});

test('an unplaced event let in on its title or its site waits for the model, however long', () => {
  const weak = { unknownLocation: true, localSite: true, unvetted: true };
  assert.equal(cullReason(ev(weak), hubs, ON), 'Waiting to be checked');
  assert.equal(cullReason(ev({ ...weak, area: 'Bathurst' }), hubs, ON), null, 'a placed one does not');
  assert.equal(cullReason(ev({ ...weak, sources: [{ source: 'ical' }] }), hubs, ON), null, 'nor one from an area feed');
});

test('localSites: a site is local when nearly everything it lists is inside an area', () => {
  const at = (url: string, area: string, elsewhere = false) => ({ url, area, elsewhere });
  const council = 'https://www.bathurst.nsw.gov.au/events/';
  const directory = 'https://marketsguide.com.au/market/';
  const local = localSites([
    at(council + 'a', 'Bathurst'), at(council + 'b', 'Bathurst'), at(council + 'c', 'Bathurst'), at(council + 'd', ''),
    at(directory + 'a', 'Bathurst'), at(directory + 'b', 'Bathurst'), at(directory + 'c', 'Bathurst'),
    at(directory + 'd', '', true), at(directory + 'e', '', true),
    at('https://two.example/a', 'Bathurst'), at('https://two.example/b', 'Bathurst'),
    ...['a', 'b', 'c', 'd'].map((p) => at('https://allevents.in/bathurst/' + p, 'Bathurst')),
  ]);
  assert.deepEqual([...local], ['bathurst.nsw.gov.au'], 'unplaced listings count neither way; two is too few; a listings site never is');
});

test('siteOf: the host, or the account where the host is shared', () => {
  assert.equal(siteOf('https://www.bathurstregion.com.au/event/x'), 'bathurstregion.com.au');
  assert.equal(siteOf('https://www.instagram.com/BathurstRegion/p/abc/'), 'instagram.com/bathurstregion');
  assert.equal(siteOf('not a url'), '');
  assert.equal(siteOf(undefined), '');
});

test('starred and hand-added events are never culled', () => {
  assert.equal(cullReason(ev({ ...melbourne, starred: true }), hubs, ON), null);
  assert.equal(cullReason(ev({ ...melbourne, sources: [{ source: 'manual' }] }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Music', starred: true }), hubs, ON), null);
});

test('an excluded category is culled wherever it is, unless it was set by hand', () => {
  assert.equal(cullReason(ev({ category: 'music', area: 'Bathurst' }), hubs, ON), 'Excluded category: music');
  assert.equal(cullReason(ev({ category: 'Music', edited: ['category'], area: 'Bathurst' }), hubs, ON), null);
  assert.equal(cullReason(ev({ category: 'Motorsport', area: 'Bathurst' }), hubs, ON), null);
});

test('with no area on the map, nothing can be judged far from one', () => {
  assert.equal(cullReason(ev(melbourne), [{ name: 'Somewhere', lat: null, lng: null, radiusKm: 50 }], ON), null);
});

test('the model turning a listing down culls it with its reason, unless starred', () => {
  assert.equal(cullReason(ev({ notEvent: 'a race report' }), hubs, {}), 'Not an event: a race report');
  assert.equal(cullReason(ev({ notEvent: 'a race report', starred: true }), hubs, {}), null);
  assert.equal(cullReason(ev({ pending: true }), hubs, {}), 'Waiting to be checked');
  assert.equal(cullReason(ev({ pending: true, area: 'Bathurst' }), hubs, {}), null);
  assert.equal(cullReason(ev({ pending: true, sources: [{ source: 'manual' }] }), hubs, {}), null);
});

test('vetting: new events wait for the model, a few hours at most', () => {
  const found = '2026-09-17T00:00:00.000Z';
  const at = (h: number): number => Date.parse(found) + h * 3600_000;
  const unread = { llm_vet_note: '', llm_vetted_at: '' };
  assert.deepEqual(vetting([unread], found, true, at(1)), { notEvent: '', pending: true, shownAt: '2026-09-17T06:00:00.000Z', unvetted: true });
  assert.equal(vetting([unread], found, true, at(7)).pending, false, 'shown anyway once the wait is up');
  assert.equal(vetting([unread], found, true, at(7)).unvetted, true, 'but still not passed');
  assert.deepEqual(vetting([unread], found, false, at(1)), { notEvent: '', pending: false, shownAt: found, unvetted: false }, 'no waiting with the check off');

  const yes = { llm_vet_note: '', llm_vetted_at: '2026-09-17T00:20:00.000Z' };
  const no = { llm_vet_note: 'a race report', llm_vetted_at: '2026-09-17T00:10:00.000Z' };
  assert.deepEqual(vetting([yes, no], found, true, at(1)), { notEvent: '', pending: false, shownAt: yes.llm_vetted_at, unvetted: false }, 'one yes is enough');
  assert.equal(vetting([no, unread], found, true, at(1)).notEvent, 'a race report');

  // An event from before the check existed, read today, is not new today.
  const late = { llm_vet_note: '', llm_vetted_at: '2026-09-20T00:00:00.000Z' };
  assert.equal(vetting([late], found, true, at(80)).shownAt, '2026-09-17T06:00:00.000Z');
});

test('a far town with a heading of its own is still outside every area', () => {
  const armidale = { lat: -30.5145, lng: 151.6657 };
  assert.match(cullReason(ev({ locality: 'Armidale' }), hubs, ON, () => [armidale]) ?? '', /^\d+ km from \w+, the nearest area$/);
});

test('a listing that names a state none of the areas are in is culled', () => {
  const rules = { ...ON, areaRegions: ['nsw'] };
  assert.equal(cullReason(ev({ region: 'qld', locality: 'Toowoomba' }), hubs, rules), 'In Queensland, outside every area');
  assert.equal(cullReason(ev({ region: 'nt' }), hubs, rules), 'In the Northern Territory, outside every area');
  assert.equal(cullReason(ev({ region: 'nsw', ...bathurstTown }), hubs, rules), null, 'the same state is judged on distance');
  assert.equal(cullReason(ev({ region: 'qld', ...bathurstTown }), hubs, ON), null, 'nothing known about the areas, no rule');
  assert.equal(cullReason(ev({ region: 'qld', starred: true }), hubs, rules), null);
});

// ---------- detectNotAnEvent ----------------------------------------------------

test('detectNotAnEvent: homepage titles are detected', () => {
  assert.ok(detectNotAnEvent('Home - Bathurst 6 Hour', undefined, 'https://bathurst6hour.com.au/'), 'homepage dash pattern');
  assert.ok(detectNotAnEvent('Home | Bathurst Cycling Festival', undefined, undefined), 'homepage pipe pattern without URL');
  assert.ok(detectNotAnEvent('Welcome to Bathurst Events', undefined, undefined), 'welcome-to pattern');
  assert.ok(detectNotAnEvent('Homepage – Events', undefined, undefined), 'homepage word');
});

test('detectNotAnEvent: contact page titles are detected', () => {
  assert.ok(detectNotAnEvent('Contact Us', undefined, 'https://bathurstbiggestexpo.com/contact-us/'), 'contact us with url');
  assert.ok(detectNotAnEvent('contact', undefined, undefined), 'lowercase contact');
});

test('detectNotAnEvent: about page titles are detected', () => {
  assert.ok(detectNotAnEvent('About', undefined, 'https://www.bathurst.nsw.gov.au/About'), 'about title');
  assert.ok(detectNotAnEvent('about us', undefined, undefined), 'about us lowercase');
});

test('detectNotAnEvent: site info URL paths are detected', () => {
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/about-us/team'), 'about-us url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/privacy/policy'), 'privacy url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/terms/'), 'terms url path');
  assert.ok(detectNotAnEvent('Something', undefined, 'https://example.com/contact/form'), 'contact url path');
});

test('detectNotAnEvent: volunteer / staff recruitment pages are detected', () => {
  assert.ok(detectNotAnEvent('Volunteer Application - Challenge Bathurst'), 'volunteer application');
  assert.ok(detectNotAnEvent('Motorsport Officials & Volunteers | Challenge Bathurst Event'), 'officials & volunteers');
  assert.ok(detectNotAnEvent('Officials Application - Challenge Bathurst'), 'officials application');
  assert.ok(detectNotAnEvent('Volunteers Needed for the Bathurst 12 Hour'), 'volunteers needed');
  assert.ok(detectNotAnEvent('Call for Volunteers - Bathurst Running Festival'), 'call for volunteers');
  assert.ok(detectNotAnEvent('Marshals Wanted – Bathurst 1000'), 'marshals wanted');
});

test('detectNotAnEvent: vendor / stallholder / grant application pages are detected', () => {
  assert.ok(detectNotAnEvent('Stallholders Application - Bathurst Expo'), 'stallholders application');
  assert.ok(detectNotAnEvent('Stallholder Application'), 'stallholder application');
  assert.ok(detectNotAnEvent('Vendor Application – Markets'), 'vendor application');
  assert.ok(detectNotAnEvent('Exhibitor Application - Motor Show'), 'exhibitor application');
  assert.ok(detectNotAnEvent('Grant Application 2026'), 'grant application');
});

test('detectNotAnEvent: standalone nav section titles are detected', () => {
  assert.ok(detectNotAnEvent('Stallholders'), 'stallholders nav section');
  assert.ok(detectNotAnEvent('Sponsors'), 'sponsors nav section');
  assert.ok(detectNotAnEvent('Volunteers'), 'volunteers nav section');
  assert.ok(detectNotAnEvent('Officials'), 'officials nav section');
  assert.ok(detectNotAnEvent('Marshals'), 'marshals nav section');
});

test('detectNotAnEvent: news / blog / press recaps are detected', () => {
  assert.ok(
    detectNotAnEvent('Engel emotional after Bathurst breakthrough | Bathurst 12 Hour', undefined, 'https://www.bathurst12hour.com.au/news/engel-emotional'),
    'news article with emotional + breakthrough keywords'
  );
  assert.ok(
    detectNotAnEvent('Race Results – Round 3', undefined, 'https://example.com/blog/results-2026'),
    'blog post with results keyword'
  );
  assert.ok(
    detectNotAnEvent('Stunning recap of the Bathurst 1000', undefined, 'https://example.com/press/recap'),
    'press recap'
  );
});

test('detectNotAnEvent: real events return null', () => {
  // Root URL but non-homepage title — should NOT be detected
  assert.equal(detectNotAnEvent('Challenge Bathurst', undefined, 'https://www.challengebathurst.com/'), null, 'real event at root URL');
  // Normal real event titles
  assert.equal(detectNotAnEvent('Echoes of Pink Floyd - Shine On Tour'), null, 'real music event');
  assert.equal(detectNotAnEvent('Repco Bathurst 1000'), null, 'real motorsport event');
  assert.equal(detectNotAnEvent('Bathurst Track Day 2026'), null, 'real track day event');
  // A news URL without recap keywords should NOT be blocked
  assert.equal(
    detectNotAnEvent('Bathurst 12 Hour Preview 2026', undefined, 'https://example.com/news/preview'),
    null,
    'news URL without recap keyword is fine'
  );
});

test('detectNotAnEvent: cullReason uses rule-based detection before LLM notEvent', () => {
  // Should be culled by rule-based detection even without notEvent set
  const homepageEv = ev({ title: 'Home - Bathurst Events', sources: [{ source: 'crawler', url: 'https://bathurst.com/' }] });
  assert.ok(cullReason(homepageEv, hubs, {}), 'homepage detected by rule');

  // A volunteer application page should be culled regardless of LLM
  const volunteerEv = ev({ title: 'Volunteer Application - Bathurst Festival', sources: [{ source: 'crawler' }] });
  assert.ok(cullReason(volunteerEv, hubs, {}), 'volunteer application detected by rule');

  // Starred even with a bad title should never be culled
  const starredEv = ev({ title: 'Home - Bathurst Events', starred: true, sources: [{ source: 'crawler' }] });
  assert.equal(cullReason(starredEv, hubs, {}), null, 'starred events are never culled');

  // Manual source should never be culled
  const manualEv = ev({ title: 'Contact Us', sources: [{ source: 'manual' }] });
  assert.equal(cullReason(manualEv, hubs, {}), null, 'manual source is never culled');
});


test('detectNotAnEvent: a page listing events is not one', () => {
  assert.ok(detectNotAnEvent('Event Calendar | Bathurst Neighbourhood Centre'));
  assert.ok(detectNotAnEvent('Events'));
  assert.ok(detectNotAnEvent("What's On - Bathurst Region"));
  assert.equal(detectNotAnEvent('Events Management Conference 2026'), null);
  assert.equal(detectNotAnEvent('Calendar Girls - Bathurst Theatre Company'), null);
});

test('siteOf and localSites: a leading www or m is dropped, and only that', () => {
  assert.equal(siteOf('https://m.facebook.com/SomePage/events'), 'facebook.com/somepage');
  assert.equal(siteOf('https://museumsbathurst.com.au/x'), 'museumsbathurst.com.au', 'an m that is part of the name stays');
  const many = ['a', 'b', 'c'].map((p) => ({ url: 'https://notallevents.info/' + p, area: 'Bathurst', elsewhere: false }));
  assert.deepEqual([...localSites(many)], ['notallevents.info'], 'a name that only ends like a listings site');
});

// The one that was announced: a Victorian track day, filed under Bathurst for the wrong day.
const relay = {
  title: '10 Hour Relay Event — SAT 10 OCT Melbourne',
  description: "10 Hour Relay Event — Euro & Classic track day in Melbourne, VIC on Saturday 10 October 2026. Hosted by Alfa Romeo Owners' Club Of Australia (VIC) Inc.. At Winton Raceway.",
  startTime: new Date(2026, 9, 14, 9).toISOString(),
};

test('a listing whose own words put it in another state is culled, even when it was filed under an area', () => {
  const rules = { ...ON, areaRegions: ['nsw'] };
  const filed = ev({ ...bathurstTown, area: 'Bathurst', title: 'Euro & Classic track day', description: relay.description });
  assert.equal(cullReason(filed, hubs, rules), 'Says it is in Victoria, outside every area');
  // Its own state as well: a Bathurst event with interstate entrants stays.
  assert.equal(cullReason({ ...filed, description: 'Teams from Melbourne, VIC and Orange, NSW at Mount Panorama.' }, hubs, rules), null);
  // Somebody set the place by hand, or starred it.
  assert.equal(cullReason({ ...filed, edited: ['address'] }, hubs, rules), null);
  assert.equal(cullReason({ ...filed, starred: true }, hubs, rules), null);
  // With no region known for the areas there is nothing to contradict.
  assert.equal(cullReason(filed, hubs, ON), null);
});

test('only a town with its region counts as naming one', () => {
  assert.deepEqual(regionsNamedIn('Track day in Melbourne, VIC on Saturday'), ['vic']);
  assert.deepEqual(regionsNamedIn('9/256 Bolton St, Eltham VIC 3095'), ['vic']);
  assert.deepEqual(regionsNamedIn('Mount Panorama, Bathurst, NSW'), ['nsw']);
  assert.deepEqual(regionsNamedIn("Alfa Romeo Owners' Club Of Australia (VIC) Inc. with the ACT Government and DJ WA"), []);
  assert.deepEqual(regionsNamedIn('Doors at 7, BYO, RSVP by Friday'), []);
});

test('a title that names another day than the one listed is culled', () => {
  assert.equal(titleDateMismatch(relay.title, relay.startTime), '2026-10-10');
  assert.equal(cullReason(ev({ ...bathurstTown, area: 'Bathurst', ...relay, description: '' }), hubs, ON), 'Its title says 2026-10-10, not the day it is listed for');
  // The day it is listed for, or a day inside a longer run.
  assert.equal(titleDateMismatch(relay.title, new Date(2026, 9, 10, 9).toISOString()), null);
  assert.equal(titleDateMismatch('Bathurst 1000 — SAT 10 OCT', new Date(2026, 9, 8, 9).toISOString(), new Date(2026, 9, 11, 17).toISOString()), null);
  // No date in the title, or the date was set by hand.
  assert.equal(titleDateMismatch('Cars and Coffee', relay.startTime), null);
  assert.equal(cullReason(ev({ ...bathurstTown, area: 'Bathurst', ...relay, description: '', edited: ['startTime'] }), hubs, ON), null);
});

test('pages of an event site that are not events are caught: sections, ticket types, packages', () => {
  const junk: [string, string][] = [
    ['2026 Boost Mobile Gold Coast 500 | Getting Around | Supercars', 'https://www.supercars.com/events/2026-gold-coast/getting-around'],
    ['2026 Boost Mobile Gold Coast 500 | Plan Your Visit | Supercars', 'https://www.supercars.com/events/2026-gold-coast/plan-your-visit'],
    ['2026 Penrite Oil Sandown 500 | Schedule | Supercars', 'https://www.supercars.com/events/2026-sandown/schedule'],
    ['2026 bp Adelaide Grand Final | Tickets and Packages | Supercars', 'https://www.supercars.com/events/2026-adelaide/tickets-and-packages'],
    ['2026 Penrite Oil Sandown 500 | Whats on | Supercars', 'https://www.supercars.com/events/2026-sandown/whats-on'],
    ['2026 Boost Mobile Gold Coast 500 | Community | Supercars', 'https://www.supercars.com/events/2026-gold-coast/community'],
    ['2026 Repco Supercars Championship | Track Club | Supercars', 'https://www.supercars.com/trackclub'],
    ['2026 Boost Mobile Gold Coast 500 - Supercars Track Club', 'https://trackclub.supercars.com/event/supercars-track-club-ettwqm'],
    ['Supercars and Super2 Calendar | Supercars', 'https://www.supercars.com/calendar?tab=UPCOMING'],
    ['Penrite Oil Sandown 500: General Admission', 'https://tickets.supercars.com/shows/Show.aspx?sh=SANDGA26'],
    ['Penrite Oil Sandown 500: Unreserved Upgrade', 'https://tickets.supercars.com/shows/Show.aspx?sh=SANDBU26'],
    ['2026 Boost Mobile Gold Coast 500 Pit Lane Walk', 'https://tickets.supercars.com/shows/Show.aspx?sh=GOLDPW26'],
    ['Pit Garage Suite - Level 1 | Supercars', 'https://www.supercars.com/tickets/exclusive-experiences/2026-gold-coast-500'],
    ['The Lounge | Supercars', 'https://www.supercars.com/tickets/shared-experiences/2026-gold-coast-500'],
    ['Victory Club', 'https://travel.supercars.com/experiences/victory-club'],
    ['Video Landing Page | Supercars', 'https://www.supercars.com/videos'],
  ];
  for (const [title, url] of junk) assert.ok(detectNotAnEvent(title, '', url), `should catch: ${title}`);

  const real: [string, string][] = [
    ['2026 Boost Mobile Gold Coast 500 | Supercars', 'https://www.supercars.com/events/2026-gold-coast'],
    ['Repco Bathurst 1000 | Supercars', 'https://www.supercars.com/events/2026-bathurst'],
    ['Mount Panorama Cars and Coffee - October', 'https://www.instagram.com/p/abc123/'],
    ['Bathurst Swap Meet | Bathurst Regional Council', 'https://www.bathurst.nsw.gov.au/events/swap-meet'],
    ['Bathurst Show: Grand Parade', 'https://bathurstshow.com.au/grand-parade'],
    ['Challenge Bathurst', 'https://challengebathurst.com/'],
  ];
  for (const [title, url] of real) assert.equal(detectNotAnEvent(title, '', url), null, `should keep: ${title}`);
});

test('a category hidden for one area is hidden only for events filed under it', () => {
  const rules = { areaHiddenCategories: { penrith: ['Motorsport'] } };
  assert.equal(cullReason(ev({ area: 'Penrith' }), hubs, rules), 'Excluded category in Penrith: Motorsport');
  assert.equal(cullReason(ev({ area: 'penrith' }), hubs, rules), 'Excluded category in penrith: Motorsport', 'any case');
  assert.equal(cullReason(ev({ area: 'Bathurst' }), hubs, rules), null);
  assert.equal(cullReason(ev({ area: '' }), hubs, rules), null);
  assert.equal(cullReason(ev({ area: 'Penrith', edited: ['category'] }), hubs, rules), null, 'a category set by hand stays');
  assert.equal(cullReason(ev({ area: 'Penrith', category: 'Music' }), hubs, { ...rules, excludedCategories: ['Music'] }), 'Excluded category: Music', 'the global list still applies');
});
