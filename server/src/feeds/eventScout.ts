/**
 * Nearby events and venue busyness for a spot or place, read from the events
 * engine in this process (src/events/).
 */
import { Db } from '../db.js';
import { densityAreas, densityHistory, densityVenues, listEvents } from '../events/local.js';
import { haversine } from '../geo.js';

const CACHE_TTL_MS = 15 * 60_000;

export interface ScoutEvent {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  venueName: string;
  address: string;
  locality: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  category: string;
  [key: string]: unknown;
}

export interface DensityArea { slug: string; name: string; venues: number; withProfile: boolean }
export interface DensityVenue {
  name: string; lat: number; lon: number; live: number | null; typical: number | null; score: number | null;
  observedAt: string | null; busiestDay: string | null; busiestHour: number | null; quietestDay: string | null;
  openDays: string[]; shoot: boolean;
}
export interface DensityHistory { daySummary: { best?: string }[]; now: unknown }

function cached<T>(db: Db, key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const raw = db.getKv(key);
  if (raw) return Promise.resolve(JSON.parse(raw) as T);
  return fetcher().then((value) => {
    db.setKv(key, JSON.stringify(value), new Date(Date.now() + ttlMs).toISOString());
    return value;
  });
}

// --- events -------------------------------------------------------------------

/** Events cached ~15 min, bucketed by the hour so nearby calls share a cache entry. */
export function eventsCached(db: Db, days = 7): Promise<ScoutEvent[]> {
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS);
  return cached(db, `eventscout:events:${bucket}`, CACHE_TTL_MS, () => {
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    return Promise.resolve(listEvents({ from: from.toISOString(), to: to.toISOString(), limit: '500' }) as unknown as ScoutEvent[]);
  });
}

/** Pure: events within `radiusKm` of a point. */
export function filterEventsNearby(events: ScoutEvent[], lat: number, lng: number, radiusKm = 10): ScoutEvent[] {
  return events.filter((e) => typeof e.lat === 'number' && typeof e.lng === 'number' && haversine(lat, lng, e.lat, e.lng) <= radiusKm * 1000);
}

/** Pure: flag events whose title contains one of the spot's event keywords (case-insensitive). */
export function flagEventKeywords<T extends { title: string }>(events: T[], keywords: string[]): (T & { goodDuring: boolean })[] {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return events.map((e) => ({ ...e, goodDuring: kws.some((k) => e.title.toLowerCase().includes(k)) }));
}

// --- busyness -------------------------------------------------------------------

export function densityAreasCached(db: Db): Promise<{ areas: DensityArea[] }> {
  return cached(db, 'eventscout:areas', CACHE_TTL_MS, async () => densityAreas() as unknown as { areas: DensityArea[] });
}
export function densityVenuesCached(db: Db, slug: string): Promise<DensityVenue[]> {
  return cached(db, `eventscout:venues:${slug}`, CACHE_TTL_MS, async () => densityVenues(slug) as unknown as DensityVenue[]);
}
export function densityHistoryCached(db: Db, slug: string, venue: string, days = 14): Promise<DensityHistory> {
  return cached(db, `eventscout:history:${slug}:${venue}`, CACHE_TTL_MS, async () => {
    const history = densityHistory(slug, venue, days);
    if (!history) throw new Error('Unknown venue');
    return history as unknown as DensityHistory;
  });
}

/** Pure: nearest venue to a point within `maxKm`, across every area's venue list already fetched. */
export function nearestVenue(areaVenues: { slug: string; venues: DensityVenue[] }[], lat: number, lng: number, maxKm = 2): { slug: string; venue: DensityVenue } | null {
  let best: { slug: string; venue: DensityVenue; km: number } | null = null;
  for (const { slug, venues } of areaVenues) {
    for (const venue of venues) {
      const km = haversine(lat, lng, venue.lat, venue.lon) / 1000;
      if (km <= maxKm && (!best || km < best.km)) best = { slug, venue, km };
    }
  }
  return best ? { slug: best.slug, venue: best.venue } : null;
}

export interface NearbyResult {
  events: (ScoutEvent & { goodDuring: boolean })[];
  crowd: { venue: string; live: number | null; typical: number | null; score: number | null; bestWindow: string | null } | null;
  status: 'ok';
}

/** Everything a spot/place panel needs: nearby events (7 days, keyword-flagged) and crowd now vs typical. */
export async function nearbyFor(db: Db, lat: number, lng: number, eventKeywords: string[], radiusKm = 10): Promise<NearbyResult> {

  const allEvents = await eventsCached(db);
  const events = flagEventKeywords(filterEventsNearby(allEvents, lat, lng, radiusKm), eventKeywords);

  const { areas } = await densityAreasCached(db);
  const areaVenues = await Promise.all(areas.map(async (a) => ({ slug: a.slug, venues: await densityVenuesCached(db, a.slug) })));
  const nearest = nearestVenue(areaVenues, lat, lng);
  let crowd: NearbyResult['crowd'] = null;
  if (nearest) {
    const history = await densityHistoryCached(db, nearest.slug, nearest.venue.name).catch(() => null);
    crowd = {
      venue: nearest.venue.name, live: nearest.venue.live, typical: nearest.venue.typical, score: nearest.venue.score,
      bestWindow: history?.daySummary?.[0]?.best ?? null,
    };
  }
  return { events, crowd, status: 'ok' };
}
