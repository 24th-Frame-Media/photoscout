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
  showHidden: boolean;
  starredOnly: boolean;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = {
  dateChip: 'all', category: '', place: '', search: '', hideOnline: true, showHidden: false, starredOnly: false, sort: 'date',
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
    priceText: c.priceText, isOnline: false, dateOnly: false, photoScore: 0, series: '', url: '', starred: false, hidden: false,
    community: true, communityId: c.id, ownerId: c.ownerId, organiser: c.owner.username, going: c.going, isGoing: c.isGoing, cruise: c.cruise,
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
