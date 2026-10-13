/**
 * Events for the Events pages and the map.
 *
 * The events engine (src/events/) knows everything about a listing: its raw
 * text, every source's address, paths on this server's disk. A visitor gets the
 * cut-down shape below instead, and only what has not been taken out of sight
 * there. Which events a person has starred or hidden is theirs and lives here
 * (see user_event_state).
 */
import { Db } from './db.js';
import { listEvents } from './events/local.js';
import { isSafeFlyerPath } from './events/flyers.js';

export const MAX_GROUP_LENGTH = 100;
const CACHE_MS = 60_000;
const MAX_DESCRIPTION = 1500;

export interface EventItem {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string | null;
  venueName: string;
  address: string;
  locality: string;
  lat: number | null;
  lng: number | null;
  /** A stored copy of the flyer (see /api/flyer) or an https picture, or '' when there is none that a browser could load. */
  imageUrl: string;
  category: string;
  priceText: string;
  isOnline: boolean;
  /** The start carries a day and no clock time. */
  dateOnly: boolean;
  photoScore: number;
  /** Shared by every date of a repeating event, so the page can fold them. */
  series: string;
  /** One link to a listing of the event, '' when there is none. */
  url: string;
  /** The caller's own, false for a visitor. */
  starred: boolean;
  hidden: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const coord = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The URL when it is a plain web address, so a scraped `javascript:` link never reaches a page. */
function webUrl(v: unknown, httpsOnly = false): string {
  try {
    const u = new URL(str(v));
    return u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:') ? u.toString() : '';
  } catch {
    return '';
  }
}

/** The day and name in a stored flyer's address, if it is one this app could have written. */
export function flyerPathOf(src: unknown): { day: string; name: string } | null {
  const m = /^\/api\/flyer\/([^/]+)\/([^/]+)$/.exec(str(src));
  return m && isSafeFlyerPath(m[1], m[2]) ? { day: m[1], name: m[2] } : null;
}

/** Pure: one upstream event as the page gets it, or null when the engine has it out of sight or it is malformed. */
export function publicEvent(raw: unknown): EventItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  const group = str(ev.group);
  if (!group || group.length > MAX_GROUP_LENGTH) return null;
  // Out of sight by hand, or by the area and category rules there.
  if (ev.hidden === true || ev.culled) return null;
  const images = Array.isArray(ev.images) ? ev.images : [ev.imageUrl];
  const sources = Array.isArray(ev.sources) ? ev.sources : [];
  // The copy this server holds first: a scraped address can stop answering, and the copy cannot.
  const stored = images.find((src) => flyerPathOf(src));
  return {
    group,
    title: str(ev.title),
    description: str(ev.description).slice(0, MAX_DESCRIPTION),
    startTime: str(ev.startTime),
    endTime: str(ev.endTime) || null,
    venueName: str(ev.venueName),
    address: str(ev.address),
    locality: str(ev.locality),
    lat: coord(ev.lat),
    lng: coord(ev.lng),
    imageUrl: typeof stored === 'string' ? stored : images.map((src) => webUrl(src, true)).find(Boolean) ?? '',
    category: str(ev.category),
    priceText: str(ev.priceText),
    isOnline: ev.isOnline === true,
    dateOnly: ev.dateOnly === true,
    photoScore: typeof ev.photoScore === 'number' && Number.isFinite(ev.photoScore) ? ev.photoScore : 0,
    series: str(ev.series),
    url: sources.map((s) => webUrl((s as { url?: unknown } | null)?.url)).find(Boolean) ?? '',
    starred: false,
    hidden: false,
  };
}

// --- the upstream list, kept for a minute -----------------------------------

/** Where the list is read from. A property so a test can stand in for the engine. */
export const eventSource = { read: (): unknown[] => listEvents() };

let cache: { at: number; events: EventItem[]; flyers: Set<string> } | null = null;

/**
 * Every upcoming event on show, shared by all callers.
 *
 * Kept for a minute: putting the list together merges and culls every row, and
 * a visitor should not be able to make the server do that on each request. If
 * reading fails the last list is served again rather than an error.
 * ponytail: in-process, so one cache per instance; fine for the single instance this runs as.
 */
export function eventList(): EventItem[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.events;
  try {
    const events = eventSource.read().map(publicEvent).filter((e): e is EventItem => e !== null);
    cache = { at: Date.now(), events, flyers: new Set(events.map((e) => e.imageUrl).filter((src) => flyerPathOf(src))) };
    return events;
  } catch (err) {
    console.error('[events] could not read the list:', (err as Error).message);
    if (cache) {
      cache.at = Date.now();
      return cache.events;
    }
    throw Object.assign(new Error('Events are unavailable right now'), { status: 502 });
  }
}

/** Drop the kept list, so an admin's edit shows on the next read instead of in a minute. */
export function forgetEventList(): void {
  cache = null;
}

/** Whether a stored flyer belongs to an event that is on show, so a hidden or culled event's picture is not served. */
export function flyerIsShown(day: string, name: string): boolean {
  eventList();
  return cache?.flyers.has(`/api/flyer/${day}/${name}`) ?? false;
}

// --- one person's star and hide ---------------------------------------------

export interface EventState { starred: boolean; hidden: boolean }

/** Everything this person has marked, by event group. */
export function userEventStates(db: Db, userId: string): Map<string, EventState> {
  const rows = db.handle.prepare('SELECT event_group, starred, hidden FROM user_event_state WHERE user_id = ?').all(userId) as
    { event_group: string; starred: number; hidden: number }[];
  return new Map(rows.map((r) => [r.event_group, { starred: r.starred === 1, hidden: r.hidden === 1 }]));
}

/** Change what this person has marked on one event; a field left out keeps its value. */
export function setUserEventState(db: Db, userId: string, group: string, patch: Partial<EventState>): EventState {
  const row = db.handle.prepare('SELECT starred, hidden FROM user_event_state WHERE user_id = ? AND event_group = ?').get(userId, group) as
    { starred: number; hidden: number } | undefined;
  const next: EventState = { starred: patch.starred ?? row?.starred === 1, hidden: patch.hidden ?? row?.hidden === 1 };
  db.handle
    .prepare(`INSERT INTO user_event_state (user_id, event_group, starred, hidden, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, event_group) DO UPDATE SET starred = excluded.starred, hidden = excluded.hidden, updated_at = excluded.updated_at`)
    .run(userId, group, next.starred ? 1 : 0, next.hidden ? 1 : 0, new Date().toISOString());
  return next;
}

/** Pure: the events with a caller's own star and hide laid over them (none for a visitor). */
export function withState(events: EventItem[], states: Map<string, EventState> | null): EventItem[] {
  return states ? events.map((ev) => ({ ...ev, ...(states.get(ev.group) ?? {}) })) : events;
}
