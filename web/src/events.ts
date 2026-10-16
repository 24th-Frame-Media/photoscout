/**
 * Filtering, sorting and dates for the Events and Calendar pages. Ported from event-scout's
 * own web app (web/src/filtering.ts, components/EventCard.tsx). Its source and "recently found"
 * filters are not here: the list this server serves does not say where an event was found or when.
 */
import type { Area, CommunityEvent, EventItem } from './api.js';
import { haversineKm } from './map/geo.js';

export type DateChip = 'all' | 'today' | 'weekend' | 'week' | 'month';

export const DATE_CHIPS: { key: DateChip; label: string }[] = [
  { key: 'all', label: 'All upcoming' },
  { key: 'today', label: 'Today' },
  { key: 'weekend', label: 'This weekend' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'month', label: 'This month' },
];

/**
 * Over and done, by the rule event-scout uses: the end if there is one,
 * otherwise the whole of the day it starts on. Not "started an hour ago":
 * an all-day event starts at midnight and runs until the next one.
 */
export function isOver(ev: Pick<EventItem, 'startTime' | 'endTime'>, now = Date.now()): boolean {
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN;
  if (Number.isFinite(end)) return end < now;
  const start = new Date(ev.startTime);
  if (Number.isNaN(start.getTime())) return false;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime() <= now;
}

export type SortKey = 'date' | 'photo' | 'distance' | 'place';

/**
 * The location choices that are not the name of a town. Given a colon so none
 * can collide with a real place name.
 */
export const NEARBY = 'nearby:any';
export const ELSEWHERE = 'nearby:none';
/** No coordinates and no name: nothing says where it is. */
export const UNKNOWN = 'nearby:unknown';

export interface Filters {
  dateChip: DateChip;
  /** One category, or '' for every category. */
  category: string;
  /** A town (locality), NEARBY, ELSEWHERE or UNKNOWN; '' for no location filter. */
  place: string;
  search: string;
  hideOnline: boolean;
  /** One source name, or '' for every source. */
  source: string;
  /** Only events first shown in the last RECENT_DAYS. */
  recentOnly: boolean;
  showHidden: boolean;
  starredOnly: boolean;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = {
  dateChip: 'all', category: '', place: '', search: '', hideOnline: true, source: '', recentOnly: false, showHidden: false, starredOnly: false, sort: 'date',
};

/** Where "nearby" and "nearest" are measured from: the areas the app looks around, the first being home. */
export type Geo = { home: Area; areas: Area[] };

const FILTERS_KEY = 'photoscout.eventFilters';
const SORTS: SortKey[] = ['date', 'photo', 'distance', 'place'];
const CHIPS: DateChip[] = ['all', 'today', 'weekend', 'week', 'month'];

/**
 * The filters chosen on the Events page, remembered across visits.
 * Checked field by field: private mode, cleared site data or a shape saved by
 * an older version must never crash the page, only fall back to the defaults.
 */
export function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const saved = JSON.parse(raw) as Partial<Filters> | null;
    if (!saved || typeof saved !== 'object') return DEFAULT_FILTERS;
    const d = DEFAULT_FILTERS;
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    return {
      dateChip: CHIPS.includes(saved.dateChip as DateChip) ? (saved.dateChip as DateChip) : d.dateChip,
      category: str(saved.category, d.category),
      place: str(saved.place, d.place),
      search: str(saved.search, d.search),
      hideOnline: bool(saved.hideOnline, d.hideOnline),
      source: str(saved.source, d.source),
      recentOnly: bool(saved.recentOnly, d.recentOnly),
      showHidden: bool(saved.showHidden, d.showHidden),
      starredOnly: bool(saved.starredOnly, d.starredOnly),
      sort: SORTS.includes(saved.sort as SortKey) ? (saved.sort as SortKey) : d.sort,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(f: Filters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    // Private window or quota: the filters just are not remembered.
  }
}

export const RECENT_DAYS = 7;

/** First shown within RECENT_DAYS. One found before that was kept is not. */
export function isRecent(ev: Pick<EventItem, 'foundAt'>, now = Date.now()): boolean {
  if (!ev.foundAt) return false;
  return now - new Date(ev.foundAt).getTime() < RECENT_DAYS * 86400000;
}

/** Every source name in the list, sorted, for the source filter. */
export function sourcesOf(events: EventItem[]): string[] {
  return [...new Set(events.flatMap((e) => e.sources))].sort();
}

/** The days a chip stands for, as [first, day after last], or null for no limit. */
export function dateWindow(chip: DateChip, now = new Date()): [Date, Date] | null {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (chip) {
    case 'today':
      return [startOfDay, new Date(startOfDay.getTime() + 86400000)];
    case 'weekend': {
      // Upcoming Sat–Sun (if today is the weekend, the current one).
      const dow = now.getDay();
      const daysToSat = dow === 0 ? -1 : 6 - dow;
      const sat = new Date(startOfDay.getTime() + daysToSat * 86400000);
      return [dow === 0 || dow === 6 ? startOfDay : sat, new Date(sat.getTime() + 2 * 86400000)];
    }
    case 'week':
      return [startOfDay, new Date(startOfDay.getTime() + 7 * 86400000)];
    case 'month':
      return [startOfDay, new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())];
    default:
      return null;
  }
}

/**
 * The heading an event sorts and groups under.
 *
 * The venue comes first, since a trip is planned around it. A venue that opens
 * with a number is a street address, and a heading per street number is what
 * this sort exists to prevent, so it gives up its locality instead.
 * A community event has no locality, so its address stands in.
 */
export function placeLabel(ev: EventItem): string {
  const venue = (ev.venueName || '').trim();
  const startsWithNumber = /^\d/.test(venue.split(',')[0].trim());
  if (venue && !startsWithNumber) return venue;
  return (ev.locality || venue || ev.address || '').trim();
}

const hasCoords = (ev: EventItem): ev is EventItem & { lat: number; lng: number } => ev.lat != null && ev.lng != null;

/** Inside one of the areas that look for events (or home, when none is switched on). */
function isNearby(ev: EventItem, geo: Geo | null): boolean {
  if (!geo || !hasCoords(ev)) return false;
  const areas = geo.areas.filter((a) => a.events);
  return (areas.length ? areas : [geo.home]).some((a) => haversineKm(a.lat, a.lng, ev.lat, ev.lng) <= a.radiusKm);
}

/** Whether an event is in one location choice: a town, or one of the three above. */
function inPlace(ev: EventItem, choice: string, geo: Geo | null): boolean {
  if (choice === NEARBY) return isNearby(ev, geo);
  if (choice === UNKNOWN) return !hasCoords(ev) && !placeLabel(ev);
  if (choice === ELSEWHERE) return !isNearby(ev, geo) && (hasCoords(ev) || Boolean(placeLabel(ev)));
  return ev.locality === choice;
}

/**
 * The towns to offer in the location filter, busiest first, plus how many
 * events are nearby, elsewhere and of unknown location.
 */
export function placesOf(events: EventItem[], geo: Geo | null): {
  places: { name: string; count: number }[]; nearby: number; elsewhere: number; unknown: number;
} {
  const counts = new Map<string, number>();
  let nearby = 0, elsewhere = 0, unknown = 0;
  for (const ev of events) {
    if (isNearby(ev, geo)) {
      nearby++;
      if (ev.locality) counts.set(ev.locality, (counts.get(ev.locality) ?? 0) + 1);
    } else if (inPlace(ev, UNKNOWN, geo)) unknown++;
    else elsewhere++;
  }
  const places = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { places, nearby, elsewhere, unknown };
}

export function applyFilters(events: EventItem[], f: Filters, now = new Date(), geo: Geo | null = null): EventItem[] {
  const window = dateWindow(f.dateChip, now);
  const q = f.search.trim().toLowerCase();
  const out = events.filter((ev) => {
    if (!f.showHidden && ev.hidden) return false;
    if (f.starredOnly && !ev.starred) return false;
    if (f.hideOnline && ev.isOnline) return false;
    if (f.source && !ev.sources.includes(f.source)) return false;
    if (f.recentOnly && !isRecent(ev, now.getTime())) return false;
    if (f.category && ev.category !== f.category) return false;
    if (f.place && !inPlace(ev, f.place, geo)) return false;
    if (window) {
      const t = new Date(ev.startTime);
      if (t < window[0] || t >= window[1]) return false;
    }
    if (q && !`${ev.title} ${ev.venueName} ${ev.description}`.toLowerCase().includes(q)) return false;
    return true;
  });

  // Array.sort is stable, so ties keep the order they came in (start order).
  if (f.sort === 'photo') return out.sort((a, b) => b.photoScore - a.photoScore || a.startTime.localeCompare(b.startTime));
  if (f.sort === 'distance' && geo) {
    const dist = (ev: EventItem) => (hasCoords(ev) ? haversineKm(geo.home.lat, geo.home.lng, ev.lat, ev.lng) : Number.POSITIVE_INFINITY);
    return out.sort((a, b) => dist(a) - dist(b));
  }
  if (f.sort === 'place') {
    // One venue's events land together, in date order; the unnamed go last.
    return out.sort((a, b) => {
      const pa = placeLabel(a);
      const pb = placeLabel(b);
      if (!pa !== !pb) return pa ? -1 : 1;
      return pa.localeCompare(pb, undefined, { sensitivity: 'base' }) || a.startTime.localeCompare(b.startTime);
    });
  }
  return out;
}

/** One card on the Events page: an event, and every date of its series shown. */
export interface Card {
  ev: EventItem;
  /** The dates of this series that survived the filters, `ev` first. */
  dates: EventItem[];
}

/**
 * Fold the dates of a repeating event into one card.
 *
 * A class that runs all term was twenty-seven identical cards, one per date,
 * burying everything around it. After the filters rather than before, so the
 * card is for the next date that matches them. The first date in the list is
 * the one kept, which leaves the order in charge of where the card goes.
 */
export function foldSeries(list: EventItem[]): Card[] {
  const out: Card[] = [];
  const bySeries = new Map<string, Card>();
  for (const ev of list) {
    const card = ev.series ? bySeries.get(ev.series) : undefined;
    if (card) {
      card.dates.push(ev);
      continue;
    }
    const fresh: Card = { ev, dates: [ev] };
    if (ev.series) bySeries.set(ev.series, fresh);
    out.push(fresh);
  }
  return out;
}

/**
 * A community event as the list, the calendar and the map know an event.
 *
 * Its group cannot collide with a scraped one and says what it is, which is how
 * the page keeps the two apart: the category is "Community", `community` is set,
 * and starring and hiding (which belong to the scraped feed) are never offered.
 */
export function communityToItem(c: CommunityEvent): EventItem {
  return {
    group: `community:${c.id}`, title: c.title, description: c.description, startTime: c.startTime, endTime: c.endTime,
    venueName: c.venueName, address: c.address, locality: '', lat: c.lat, lng: c.lng, imageUrl: '', category: COMMUNITY_CATEGORY,
    priceText: c.priceText, isOnline: false, dateOnly: false, photoScore: 0, series: '', url: '', sources: [], foundAt: null, starred: false, hidden: false,
    community: true, communityId: c.id, ownerId: c.ownerId, organiser: c.owner.username, going: c.going, interested: 0, myRsvp: c.isGoing ? 'going' : null,
    isGoing: c.isGoing, cruise: c.cruise,
  };
}

export const COMMUNITY_CATEGORY = 'Community';

/** Scraped and community events as one list in start order; ties keep the scraped one first. */
export function mergeEvents(scraped: EventItem[], community: CommunityEvent[]): EventItem[] {
  const all = [...scraped, ...community.map(communityToItem)];
  return all
    .map((ev, i) => ({ ev, i, t: Date.parse(ev.startTime) }))
    .sort((a, b) => (Number.isNaN(a.t) ? Infinity : a.t) - (Number.isNaN(b.t) ? Infinity : b.t) || a.i - b.i)
    .map((x) => x.ev);
}

export function categoriesOf(events: EventItem[]): string[] {
  return [...new Set(events.map((e) => e.category).filter(Boolean))].sort();
}

// --- calendar ---------------------------------------------------------------

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Events by the day they start, each day in time order. */
export function groupByDay(events: EventItem[]): Map<string, EventItem[]> {
  const map = new Map<string, EventItem[]>();
  for (const ev of events) {
    const key = dayKey(new Date(ev.startTime));
    const list = map.get(key);
    if (list) list.push(ev);
    else map.set(key, [ev]);
  }
  for (const list of map.values()) list.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return map;
}

const PALETTE = ['#f5a623', '#4cc3ff', '#4ade80', '#f87171', '#c084fc', '#fb923c', '#2dd4bf', '#e879f9'];

/** Stable colour per category, so a category looks the same wherever it is drawn. */
export function categoryColour(category: string): string {
  let hash = 0;
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// --- when ---------------------------------------------------------------------

export function isMultiDay(ev: Pick<EventItem, 'startTime' | 'endTime' | 'dateOnly'>): boolean {
  if (!ev.endTime) return false;
  const start = new Date(ev.startTime);
  const end = new Date(ev.endTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return false;

  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  if (startDay === endDay) return false;

  if (ev.dateOnly) return true;

  const durationHours = (end.getTime() - start.getTime()) / 3600_000;
  if (durationHours >= 18) return true;
  if (end.getHours() >= 6) return true;

  return false;
}

export function multiDaySpan(ev: Pick<EventItem, 'startTime' | 'endTime'>): number {
  if (!ev.endTime) return 1;
  const start = new Date(ev.startTime);
  const end = new Date(ev.endTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return 1;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  return Math.max(1, Math.round((endDay - startDay) / 86400_000) + 1);
}

/**
 * When an event is on, as it appears on a card, the map and the detail panel.
 *
 * A multi-day event shows its date span, a single-day one with an end its time
 * range. The year is shown only when it is not the current one.
 */
export function formatWhen(ev: EventItem, opts: { full?: boolean } = {}, now = new Date()): string {
  const start = new Date(ev.startTime);
  const end = ev.endTime ? new Date(ev.endTime) : null;
  const multi = isMultiDay(ev);
  const startOtherYear = start.getFullYear() !== now.getFullYear();

  const startDay = start.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(startOtherYear ? { year: 'numeric' } : {}),
  });

  if (multi && end && !isNaN(end.getTime())) {
    const endOtherYear = end.getFullYear() !== now.getFullYear() || end.getFullYear() !== start.getFullYear();
    const endDay = end.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      ...(endOtherYear ? { year: 'numeric' } : {}),
    });
    const span = multiDaySpan(ev);

    if (opts.full && !ev.dateOnly) {
      const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `${startDay}, ${startTime} – ${endDay}, ${endTime} (${span} days)`;
    }
    if (opts.full && ev.dateOnly) return `${startDay} – ${endDay} (${span} days)`;
    return `${startDay} – ${endDay}`;
  }

  if (ev.dateOnly) return startDay;

  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (end && !isNaN(end.getTime()) && end > start) {
    const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const isNextDay = end.getDate() !== start.getDate();
    return `${startDay} · ${time} – ${endTime}${isNextDay ? ' (+1)' : ''}`;
  }

  return `${startDay} · ${time}`;
}

/**
 * Decode HTML entities in scraped text: a title can arrive as "Swap Meet &#8211; Car Club".
 * The browser's own parser does named and numeric alike; only text is read back, so no markup survives.
 */
export function decodeEntities(text: string): string {
  if (!text || !text.includes('&')) return text;
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

// --- when it is, in words ----------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A listing with a start and no end is taken to run this long, so "Happening now" does not last all day. */
const ASSUMED_LENGTH = 3 * HOUR;

export type Timing = { kind: 'ended' | 'now' | 'soon' | 'later' | 'unknown'; text: string };

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Where an event is on the clock, as a few words: "Happening now", "Ended", "Starts in 3 days".
 * A day-only event is "Today" for the whole of its day, since no clock time says when in it.
 * Calendar days, not 24-hour blocks, decide "tomorrow" and "in N days", so 10pm tonight and
 * 9am tomorrow are not both "in 1 day".
 */
export function timingOf(ev: Pick<EventItem, 'startTime' | 'endTime' | 'dateOnly'>, now = new Date()): Timing {
  const start = Date.parse(ev.startTime);
  if (Number.isNaN(start)) return { kind: 'unknown', text: '' };
  const t = now.getTime();
  if (isOver(ev, t)) return { kind: 'ended', text: 'Ended' };
  const end = ev.endTime ? Date.parse(ev.endTime) : NaN;
  if (start <= t) {
    if (ev.dateOnly) return { kind: 'now', text: 'Happening today' };
    if (Number.isFinite(end) || t < start + ASSUMED_LENGTH) return { kind: 'now', text: 'Happening now' };
    return { kind: 'now', text: 'Started earlier today' };
  }
  const days = Math.round((dayStart(new Date(start)) - dayStart(now)) / 86400_000);
  if (days === 0) {
    if (ev.dateOnly) return { kind: 'soon', text: 'Today' };
    const mins = Math.max(1, Math.round((start - t) / MINUTE));
    if (mins < 60) return { kind: 'soon', text: `Starts in ${plural(mins, 'minute')}` };
    return { kind: 'soon', text: `Starts in ${plural(Math.round(mins / 60), 'hour')}` };
  }
  if (days === 1) return { kind: 'soon', text: 'Starts tomorrow' };
  return { kind: days <= 7 ? 'soon' : 'later', text: `Starts in ${plural(days, 'day')}` };
}

/** The host a link points at, without "www.": what to call the link so a reader knows where it goes. */
export function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The address if it is a plain web address, so a scraped `javascript:` link never becomes a href. */
export function safeHref(url: string | null | undefined): string | undefined {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Where to look at the venue: this app's map when the event has coordinates, otherwise a Google Maps search. */
export function mapLink(ev: Pick<EventItem, 'lat' | 'lng' | 'venueName' | 'address' | 'locality'>): { href: string; internal: boolean; label: string } | null {
  if (ev.lat != null && ev.lng != null) {
    return { href: `/?lat=${ev.lat.toFixed(5)}&lng=${ev.lng.toFixed(5)}`, internal: true, label: 'Show on the map' };
  }
  const query = [ev.venueName, ev.address || ev.locality].filter(Boolean).join(', ').trim();
  if (!query) return null;
  return { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, internal: false, label: 'Search Google Maps' };
}

// --- addresses of one event ---------------------------------------------------------

/** The page for one event, which is also what a share link points at. */
export function eventPath(ev: Pick<EventItem, 'group' | 'community' | 'communityId'>): string {
  return ev.community && ev.communityId ? `/events/c/${encodeURIComponent(ev.communityId)}` : `/events/${encodeURIComponent(ev.group)}`;
}

/** The event a URL's route params name: a community id becomes its list group, a crawled group stays itself. */
export function openKeyOf(params: { group?: string; id?: string }): { group: string; communityId: string | null } | null {
  if (params.id) return { group: `community:${params.id}`, communityId: params.id };
  if (params.group) return { group: params.group, communityId: null };
  return null;
}

// --- links an event carries -----------------------------------------------------------

export interface Social { network: string; handle: string; url: string; icon: string }

const NETWORKS: { host: RegExp; network: string; icon: string }[] = [
  { host: /(^|\.)facebook\.com$/i, network: 'Facebook', icon: '📘' },
  { host: /(^|\.)instagram\.com$/i, network: 'Instagram', icon: '📷' },
  { host: /(^|\.)(twitter|x)\.com$/i, network: 'X', icon: '🐦' },
  { host: /(^|\.)tiktok\.com$/i, network: 'TikTok', icon: '🎵' },
  { host: /(^|\.)youtube\.com$/i, network: 'YouTube', icon: '▶️' },
  { host: /(^|\.)eventbrite\.[a-z.]+$/i, network: 'Eventbrite', icon: '🎟' },
  { host: /(^|\.)meetup\.com$/i, network: 'Meetup', icon: '👥' },
];

/**
 * Every distinct web address an event carries, from its listing link and its description.
 * Trailing punctuation is trimmed, which a regex over prose always picks up.
 */
export function findUrls(ev: Pick<EventItem, 'url' | 'description'>): string[] {
  const urls = new Set<string>();
  if (safeHref(ev.url)) urls.add(ev.url);
  const text = decodeEntities(ev.description ?? '');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) urls.add(m[0].replace(/[.,;:!?)\]]+$/, ''));
  return [...urls];
}

/** The description's links other than the listing itself, by host, for a "Links" list. */
export function findLinks(ev: Pick<EventItem, 'url' | 'description'>): { host: string; url: string }[] {
  return findUrls(ev).filter((u) => u !== ev.url && safeHref(u)).map((url) => ({ host: hostOf(url), url })).filter((l) => l.host);
}

/** Organiser profiles read off the links the event already carries; nothing is looked up, so nothing is guessed. */
export function findSocials(ev: Pick<EventItem, 'url' | 'description'>): Social[] {
  const found = new Map<string, Social>();
  for (const raw of findUrls(ev)) {
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const match = NETWORKS.find((n) => n.host.test(url.hostname));
    if (!match) continue;
    // The first path segment is the handle on every network here; deeper is a post or an event, which is not who runs it.
    const segment = url.pathname.split('/').filter(Boolean)[0];
    if (!segment) continue;
    let handle: string;
    try { handle = decodeURIComponent(segment).replace(/^@/, '').trim(); } catch { continue; }
    if (/^(events?|e|watch|p|posts?|share|pages|profile\.php)$/i.test(handle)) continue;
    if (!/^[A-Za-z0-9._-]{2,}$/.test(handle)) continue;
    const key = `${match.network}:${handle.toLowerCase()}`;
    if (!found.has(key)) found.set(key, { network: match.network, handle, url: raw, icon: match.icon });
  }
  return [...found.values()];
}

/** The month and day for the card's date badge: "OCT" "18", or "OCT" "18–20" across days. */
export function dateBadge(ev: Pick<EventItem, 'startTime' | 'endTime' | 'dateOnly'>): { mon: string; day: string; range: boolean; monRange: boolean } {
  const start = new Date(ev.startTime);
  const end = ev.endTime ? new Date(ev.endTime) : null;
  const mon = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' }).replace('.', '').toUpperCase();
  const multi = isMultiDay(ev) && end !== null && !isNaN(end.getTime());
  const startMon = mon(start);
  const endMon = multi && end ? mon(end) : startMon;
  const monRange = startMon !== endMon;
  return {
    mon: monRange ? `${startMon}–${endMon}` : startMon,
    day: multi && end ? `${start.getDate()}–${end.getDate()}` : String(start.getDate()),
    range: multi,
    monRange,
  };
}

/** The viewer's time zone, named, for "Times are in your local time (Australia/Sydney)". */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}
