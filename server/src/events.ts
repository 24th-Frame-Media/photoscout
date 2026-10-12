/**
 * Events from event-scout, for the Events pages and the map.
 *
 * Event Scout is an internal service that only this server may talk to, and it
 * answers with everything it knows: raw listing text, every source's address,
 * paths on its own disk. A visitor gets the cut-down shape below instead, and
 * only what event-scout has not itself taken out of sight. Which events a
 * person has starred or hidden is theirs and lives here (see user_event_state).
 */
import { Db } from './db.js';
import { guardedFetch } from './ssrf.js';

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
  /** An https picture, or '' when there is none that a browser could load. */
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

/** Pure: one upstream event as the page gets it, or null when event-scout has it out of sight or it is malformed. */
export function publicEvent(raw: unknown): EventItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  const group = str(ev.group);
  if (!group || group.length > MAX_GROUP_LENGTH) return null;
  // Out of sight by hand, or by the area and category rules there.
  if (ev.hidden === true || ev.culled) return null;
  const images = Array.isArray(ev.images) ? ev.images : [ev.imageUrl];
  const sources = Array.isArray(ev.sources) ? ev.sources : [];
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
    imageUrl: images.map((src) => webUrl(src, true)).find(Boolean) ?? '',
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

let cache: { url: string; at: number; events: EventItem[] } | null = null;
let inflight: { url: string; promise: Promise<EventItem[]> } | null = null;

/**
 * Every upcoming event event-scout shows, shared by all callers.
 *
 * Kept for a minute so visitors cannot make this server hammer event-scout, and
 * one fetch is shared by callers who arrive while it is under way. When event-
 * scout cannot be reached the last list is served again for another minute
 * rather than an error. Nothing is configured: an empty list.
 * ponytail: in-process, so one cache per instance; fine for the single instance this runs as.
 */
export function eventList(baseUrl: string): Promise<EventItem[]> {
  if (!baseUrl) return Promise.resolve([]);
  if (cache && cache.url === baseUrl && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.events);
  if (inflight?.url === baseUrl) return inflight.promise;
  const promise = guardedFetch(`${baseUrl.replace(/\/$/, '')}/api/events`, true)
    .then((buf) => {
      const raw = JSON.parse(buf.toString('utf8')) as unknown;
      if (!Array.isArray(raw)) throw new Error('event-scout did not answer with a list');
      const events = raw.map(publicEvent).filter((ev): ev is EventItem => ev !== null);
      cache = { url: baseUrl, at: Date.now(), events };
      return events;
    })
    .catch((err: Error) => {
      console.error('[events] event-scout fetch failed:', err.message);
      if (cache && cache.url === baseUrl) {
        cache.at = Date.now();
        return cache.events;
      }
      throw Object.assign(new Error('Events are unavailable right now'), { status: 502 });
    })
    .finally(() => { inflight = null; });
  inflight = { url: baseUrl, promise };
  return promise;
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
