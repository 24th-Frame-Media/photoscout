import { readCappedText } from '../nethost.js';
// We bypass facebook-event-scraper's HTTP layer (it sends incomplete headers and
// gets a 400 "Error" stub back from Facebook) and instead fetch the HTML ourselves
// with a full browser fingerprint, then reuse the library's battle-tested HTML
// parser on the result.
// @ts-ignore - internal subpath, typed via the package's own .d.ts
import * as fbParser from 'facebook-event-scraper/dist/utils/htmlParser.js';
import { EventSourceAdapter, Location, RawEvent, Settings } from './types.js';
import { expandTopics, fbQuery, rotateQueries, topicsFor } from './topics.js';
import { BROWSER_HEADERS, HONEST_HEADERS } from '../useragent.js';
import { monthIndex } from '../shared/textWhen.js';
import { parseWhen } from '../shared/when.js';

interface FbBasic {
  id: string;
  name: string;
  startTimestamp: number;
  isOnline: boolean;
  isCanceled: boolean;
  url: string;
  photo: { imageUri?: string } | null;
}
interface FbLocation {
  name: string;
  address: string;
  city: { name: string } | null;
  coordinates: { latitude: number; longitude: number } | null;
}
const parser = fbParser as {
  getBasicData(html: string): FbBasic;
  getLocation(html: string): FbLocation | null;
  getDescription(html: string): string;
  getCategories(html: string): { label: string }[];
  getEndTimestampAndTimezone(html: string, start: number): { endTimestamp: number | null };
};

// With a cookie configured in Settings, requests carry a full browser
// fingerprint: Facebook returns a 400 "Error" stub to a signed-in session whose
// headers do not match a browser's (sec-fetch-site:none, a top-level
// navigation, is essential). Without a cookie none of that is wanted: an event
// page is public, and answers a plain, honestly named request with the same
// page a browser gets. See HONEST_HEADERS.
const FULL_HEADERS: Record<string, string> = { ...BROWSER_HEADERS };

const MAX_EVENTS_PER_REFRESH = 40;
const DETAIL_DELAY_MS = 500;

export class LoginWallError extends Error {}

/** Exported for the crawler source, which reads the Facebook events the crawl finds. */
export async function fetchFb(url: string, cookie: string): Promise<string> {
  // Signed in only if someone chose to be. No cookie, no browser costume.
  const headers: Record<string, string> = cookie ? { ...FULL_HEADERS, Cookie: cookie } : { ...HONEST_HEADERS };
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  const html = await readCappedText(res, 10 * 1024 * 1024);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/You must log in to continue|Log in to Facebook|name="checkpoint"|temporarily blocked|confirm your identity/i.test(html.slice(0, 8000))) {
    throw new LoginWallError('Facebook served a login/checkpoint wall');
  }
  return html;
}

function extractEventIds(html: string): string[] {
  const ids = new Set<string>();
  for (const re of [
    /\/events\/(\d{8,})/g,
    /"__typename":"Event","id":"(\d{8,})"/g,
    /"id":"(\d{8,})","__typename":"Event"/g,
  ]) {
    for (const m of html.matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * An event page, read for what it says.
 *
 * The full parser reads the embedded data a signed-in page carries. A logged-out
 * page does not carry it (the event loads over GraphQL after the page runs), so
 * the library throws "No event data found"; what such a page does have is
 * Open Graph tags for a link preview, which name the event, its town, host and
 * day. That is thinner but true, and enough to list the event with its flyer.
 */
export function parseEvent(html: string, id: string): RawEvent | null {
  try {
    return parseFullEvent(html, id);
  } catch {
    return parseEventOg(html, id);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#039);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A <meta> tag's content by name or property, whichever order the attributes come in. */
function metaContent(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== key) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (content !== undefined) return decodeEntities(content).trim();
  }
  return undefined;
}

/**
 * "Event in Bathurst by Driving Solutions on Wednesday, November 25 2026".
 * The town and the host are each optional ("Event by ...", "Online event ..."),
 * and a clock time may follow the day.
 */
const OG_WHEN =
  /^(Online )?event(?: in (.+?))?(?: by (.+?))? on (?:[A-Za-z]+,? )?([A-Za-z]+)\.? (\d{1,2}),? (\d{4})(?: (?:at|from) (\d{1,2})(?::(\d{2}))? ?([AP]M))?/i;

/** "mount-panorama-circuit" to "Mount Panorama Circuit". */
const unslug = (slug: string): string =>
  slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * An event from a link preview alone, or null when the page does not read as one.
 *
 * What the preview carries: og:title is the event's name, og:image its flyer,
 * and og:description the town, the host and the day (no clock time, as a rule,
 * so it is a date-only listing). og:url puts the place's name in the path
 * (/events/mount-panorama-circuit/bathurst-track-day-2026/<id>/) when the host
 * gave one, which is the best venue name on offer; nothing is guessed beyond it.
 * A login wall's preview is "Facebook" and names no event, so it is refused.
 */
export function parseEventOg(html: string, id: string): RawEvent | null {
  const title = metaContent(html, 'og:title');
  const description = metaContent(html, 'og:description') ?? metaContent(html, 'description');
  if (!title || !description || /^(facebook|log in|log into facebook|error)\b/i.test(title)) return null;
  const m = OG_WHEN.exec(description);
  if (!m) return null;
  const month = monthIndex(m[4]);
  if (month === undefined) return null;
  const online = m[1];
  const town = m[2];
  const host = m[3];
  const date = `${m[6]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[5])).padStart(2, '0')}`;
  let clock = '';
  if (m[7]) {
    const hour = (Number(m[7]) % 12) + (/pm/i.test(m[9]) ? 12 : 0);
    clock = `T${String(hour).padStart(2, '0')}:${m[8] ?? '00'}:00`;
  }
  const when = parseWhen(date + clock);
  if (!when) return null;

  // The place's name is the path segment before the event's own, when there are two.
  let venueName = '';
  const slugs = /\/events\/([^/?#]+)\/([^/?#]+)\/\d+/.exec(metaContent(html, 'og:url') ?? '');
  if (slugs && !/^\d+$/.test(slugs[1])) venueName = unslug(slugs[1]);
  if (venueName.toLowerCase() === (town ?? '').toLowerCase()) venueName = '';

  return {
    sourceId: id,
    title,
    description: host ? `Hosted by ${host}` : '',
    startTime: when.startTime,
    dateOnly: when.dateOnly,
    venueName,
    address: online ? '' : (town ?? ''),
    url: `https://www.facebook.com/events/${id}`,
    imageUrl: metaContent(html, 'og:image') || undefined,
    category: 'Facebook',
    isOnline: Boolean(online),
  };
}

function parseFullEvent(html: string, id: string): RawEvent | null {
  const basic = parser.getBasicData(html);
  if (!basic?.startTimestamp || basic.isCanceled) return null;
  const loc = basic.isOnline ? null : parser.getLocation(html);
  const coords = loc?.coordinates ?? null;
  let endTime: string | undefined;
  try {
    const end = parser.getEndTimestampAndTimezone(html, basic.startTimestamp).endTimestamp;
    if (end) endTime = new Date(end * 1000).toISOString();
  } catch {
    /* end time is optional */
  }
  let category = 'Facebook';
  try {
    category = parser.getCategories(html)?.[0]?.label ?? 'Facebook';
  } catch {
    /* categories optional */
  }
  let description = '';
  try {
    description = parser.getDescription(html) ?? '';
  } catch {
    /* description optional */
  }
  return {
    sourceId: basic.id ?? id,
    title: basic.name ?? 'Untitled event',
    description,
    startTime: new Date(basic.startTimestamp * 1000).toISOString(),
    endTime,
    venueName: loc?.name ?? '',
    address: loc?.address ?? loc?.city?.name ?? '',
    lat: coords?.latitude,
    lng: coords?.longitude,
    url: basic.url ?? `https://www.facebook.com/events/${id}`,
    imageUrl: basic.photo?.imageUri ?? undefined,
    category,
    isOnline: basic.isOnline,
  };
}

export const facebook: EventSourceAdapter = {
  name: 'facebook',
  label: 'Facebook (unofficial)',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const cookie = settings.fbCookie.trim();

    // Build discovery URLs. Search terms default to "<city> events" — bare city
    // names return nothing from Facebook's search.
    const chosen = [...expandTopics(topicsFor(settings, loc.city), loc.city, fbQuery), ...settings.fbSearchTerms];
    // Each search is a full page fetch through Facebook, so the budget is
    // tighter here than for the search engines.
    const terms = rotateQueries(
      chosen.length > 0
        ? chosen
        : loc.city
          ? [`${loc.city} events`]
          : [],
      8
    );
    const discovery: { kind: string; url: string }[] = [];
    for (const term of terms) {
      if (term.trim()) discovery.push({ kind: `search "${term}"`, url: `https://www.facebook.com/events/search/?q=${encodeURIComponent(term.trim())}` });
    }
    for (const page of settings.fbPages) {
      const slug = page.trim().replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/+$/, '');
      if (slug) discovery.push({ kind: `page "${slug}"`, url: `https://www.facebook.com/${slug}/upcoming_hosted_events` });
    }

    if (discovery.length === 0) {
      throw new Error('Turn on events for an area under Settings → Areas, or add Facebook search terms / Pages in Settings.');
    }

    const ids = new Set<string>();
    const errors: string[] = [];
    let loginWalls = 0;
    for (const d of discovery) {
      try {
        const html = await fetchFb(d.url, cookie);
        for (const id of extractEventIds(html)) ids.add(id);
      } catch (err) {
        if (err instanceof LoginWallError) loginWalls++;
        errors.push(`${d.kind}: ${(err as Error).message}`);
      }
    }

    if (ids.size === 0) {
      if (loginWalls > 0 || !cookie) {
        throw new Error(
          cookie
            ? 'Facebook is showing a login/checkpoint wall — the cookie may be expired or flagged. Re-copy a fresh c_user + xs cookie in Settings.'
            : 'Facebook lists no events to someone who is not signed in (searches and Pages fill in after the page loads). ' +
                'Event links the web crawler finds are still read without a cookie; to search or list a Page here, add a c_user + xs cookie in Settings.'
        );
      }
      throw new Error(
        errors.length > 0
          ? `Found no events. ${errors[0]}. Facebook search is also inconsistent — try a more specific term or add Pages.`
          : 'Found no events — Facebook search returned nothing. Try a more specific term or add Pages.'
      );
    }

    const events: RawEvent[] = [];
    let detailWalls = 0;
    for (const id of [...ids].slice(0, MAX_EVENTS_PER_REFRESH)) {
      try {
        const html = await fetchFb(`https://www.facebook.com/events/${id}`, cookie);
        const ev = parseEvent(html, id);
        if (!ev) continue;
        events.push(ev);
      } catch (err) {
        if (err instanceof LoginWallError) detailWalls++;
        // Individual failures (private/expired/blocked) are expected — skip.
      }
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }

    if (events.length === 0 && detailWalls > 0) {
      throw new Error('Facebook blocked the event detail pages (login/checkpoint wall). Re-copy a fresh cookie in Settings.');
    }
    return events;
  },
};
