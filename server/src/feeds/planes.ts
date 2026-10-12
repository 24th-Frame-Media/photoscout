/** adsb.lol (or airplanes.live, same API) point search, plus dead-reckoning. On-demand only, no background polling. */

export interface Plane {
  hex: string;
  flight: string;
  lat: number;
  lon: number;
  track: number | null;
  gs: number | null; // knots
  alt_baro: number | null;
  t: string; // aircraft type
  seen: number; // seconds since last message
}

export interface AdsbAircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  track?: number;
  gs?: number;
  alt_baro?: number | 'ground';
  t?: string;
  seen?: number;
}

function toPlane(a: AdsbAircraft): Plane | null {
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
  return {
    hex: a.hex,
    flight: (a.flight ?? '').trim(),
    lat: a.lat,
    lon: a.lon,
    track: typeof a.track === 'number' ? a.track : null,
    gs: typeof a.gs === 'number' ? a.gs : null,
    alt_baro: a.alt_baro === 'ground' ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null,
    t: a.t ?? '',
    seen: a.seen ?? 0,
  };
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; planes: Plane[] }>();

const GRID_DEG = 0.25; // ~25km: requests snap to this grid so panning reuses one upstream call
const MIN_GAP_MS = 5_000; // never hit upstream more often than this, whatever the key
let lastFetchAt = 0;
let backoffUntil = 0;
const inflight = new Map<string, Promise<Plane[]>>();

const snap = (v: number) => Math.round(v / GRID_DEG) * GRID_DEG;

/** Snapped to the grid, with the radius padded so the snapped circle still covers the asked-for one. */
function cacheKey(lat: number, lng: number, nm: number): string {
  return `${snap(lat).toFixed(2)},${snap(lng).toFixed(2)},${Math.ceil((nm + 12) / 10) * 10}`;
}

/** Nearest cached result, however old — served while rate-limited or backing off rather than erroring. */
function stale(key: string): Plane[] {
  return cache.get(key)?.planes ?? [...cache.values()].sort((a, b) => b.at - a.at)[0]?.planes ?? [];
}

/** adsb.fi's open data API: the same readsb records, from a different receiver network. */
const ADSB_FI = 'https://opendata.adsb.fi/api/v2';

/** The configured feed plus adsb.fi, so a plane seen by either network shows up. */
function sourceUrls(baseUrl: string, lat: number, lng: number, nm: number): string[] {
  return [`${baseUrl.replace(/\/$/, '')}/v2/point/${lat}/${lng}/${nm}`, `${ADSB_FI}/lat/${lat}/lon/${lng}/dist/${nm}`];
}

/** Aircraft from several feeds, one per ICAO hex; the first feed that has a plane wins. Failed feeds are null. */
export function mergeAircraft(lists: (AdsbAircraft[] | null)[]): AdsbAircraft[] {
  const byHex = new Map<string, AdsbAircraft>();
  for (const list of lists) for (const a of list ?? []) { const hex = String(a.hex ?? '').toLowerCase(); if (hex && !byHex.has(hex)) byHex.set(hex, a); }
  return [...byHex.values()];
}

export async function fetchPlanes(baseUrl: string, lat: number, lng: number, nm: number): Promise<Plane[]> {
  const key = cacheKey(lat, lng, nm);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.planes;
  if (now < backoffUntil || now - lastFetchAt < MIN_GAP_MS) return stale(key);
  const pending = inflight.get(key);
  if (pending) return pending;

  const [sLat, sLng, sNm] = key.split(',').map(Number);
  lastFetchAt = now;
  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const lists = await Promise.all(sourceUrls(baseUrl, sLat, sLng, sNm).map(async (url) => {
        // adsb.lol 403s a request with no User-Agent at all (Node's fetch sends none by default).
        const res = await fetch(url, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: controller.signal }).catch(() => null);
        if (res?.status === 429) {
          const retry = Number(res.headers.get('retry-after'));
          backoffUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000);
        }
        if (!res?.ok) return null;
        const data = (await res.json().catch(() => null)) as { ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] } | null;
        return data ? (data.ac ?? data.aircraft ?? []) : null;
      }));
      if (lists.every((l) => l === null)) {
        if (Date.now() < backoffUntil) return stale(key);
        throw new Error('no plane source answered');
      }
      const planes = mergeAircraft(lists).map(toPlane).filter((pl): pl is Plane => pl !== null);
      cache.set(key, { at: Date.now(), planes });
      return planes;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const KNOTS_TO_KMH = 1.852;
const EARTH_KM = 6371;

/** Great-circle projection along track and ground speed, `minutes` ahead. Null if track/speed are unknown. */
export function deadReckon(plane: Pick<Plane, 'lat' | 'lon' | 'track' | 'gs'>, minutes: number): { lat: number; lon: number } | null {
  if (plane.track == null || plane.gs == null) return null;
  const km = (plane.gs * KNOTS_TO_KMH * minutes) / 60;
  const d = km / EARTH_KM;
  const brg = (plane.track * Math.PI) / 180;
  const la1 = (plane.lat * Math.PI) / 180;
  const lo1 = (plane.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
  const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (((lo2 * 180) / Math.PI + 540) % 360) - 180 };
}

export interface PlaneInfo {
  type: string | null;
  manufacturer: string | null;
  registration: string | null;
  owner: string | null;
  airline: string | null;
  origin: string | null;
  destination: string | null;
}

export interface AircraftDetails {
  type: string | null;
  manufacturer: string | null;
  registration: string | null;
  owner: string | null;
}

export interface FlightrouteDetails {
  airline: string | null;
  origin: string | null;
  destination: string | null;
}

export function isValidHex(hex: unknown): hex is string {
  return typeof hex === 'string' && /^[0-9a-fA-F]{6}$/.test(hex);
}

export function isValidCallsign(cs: unknown): cs is string {
  return typeof cs === 'string' && /^[0-9a-zA-Z]{1,8}$/.test(cs);
}

/** Parse an adsbdb aircraft API response into normalized aircraft fields, or null if unknown / invalid. */
export function parseAircraft(raw: unknown): AircraftDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const res = (raw as Record<string, unknown>).response;
  if (!res || typeof res !== 'object') return null;
  const ac = (res as Record<string, unknown>).aircraft;
  if (!ac || typeof ac !== 'object') return null;
  const a = ac as Record<string, unknown>;

  const type = (typeof a.type === 'string' && a.type.trim())
    || (typeof a.icao_type === 'string' && a.icao_type.trim())
    || null;
  const manufacturer = (typeof a.manufacturer === 'string' && a.manufacturer.trim()) || null;
  const registration = (typeof a.registration === 'string' && a.registration.trim()) || null;
  const owner = (typeof a.registered_owner === 'string' && a.registered_owner.trim())
    || (typeof a.owner === 'string' && a.owner.trim())
    || null;

  return { type, manufacturer, registration, owner };
}

/** Parse an adsbdb flightroute API response into normalized airline and route fields, or null if unknown / invalid. */
export function parseFlightroute(raw: unknown): FlightrouteDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const res = (raw as Record<string, unknown>).response;
  if (!res || typeof res !== 'object') return null;
  const fr = (res as Record<string, unknown>).flightroute;
  if (!fr || typeof fr !== 'object') return null;
  const f = fr as Record<string, unknown>;

  const airlineObj = f.airline as Record<string, unknown> | undefined;
  const airline = (airlineObj && typeof airlineObj.name === 'string' && airlineObj.name.trim()) || null;

  const originObj = f.origin as Record<string, unknown> | undefined;
  const origin = (originObj && (
    (typeof originObj.iata_code === 'string' && originObj.iata_code.trim())
    || (typeof originObj.municipality === 'string' && originObj.municipality.trim())
    || (typeof originObj.icao_code === 'string' && originObj.icao_code.trim())
  )) || null;

  const destObj = f.destination as Record<string, unknown> | undefined;
  const destination = (destObj && (
    (typeof destObj.iata_code === 'string' && destObj.iata_code.trim())
    || (typeof destObj.municipality === 'string' && destObj.municipality.trim())
    || (typeof destObj.icao_code === 'string' && destObj.icao_code.trim())
  )) || null;

  return { airline, origin, destination };
}

interface CacheItem<T> {
  val: T;
  exp: number;
}

/** Map with TTL expiry and capacity cap, dropping oldest on overflow. Supports negative caching. */
export class ExpiryCache<T> {
  private map = new Map<string, CacheItem<T>>();

  constructor(private ttlMs: number, private maxEntries = 5000) {}

  get(key: string): { hit: boolean; val: T | undefined } {
    const item = this.map.get(key);
    if (!item) return { hit: false, val: undefined };
    if (Date.now() > item.exp) {
      this.map.delete(key);
      return { hit: false, val: undefined };
    }
    return { hit: true, val: item.val };
  }

  set(key: string, val: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { val, exp: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const AIRCRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_CAP = 5000;
const ADS_B_DB_TIMEOUT_MS = 5000;

export const aircraftCache = new ExpiryCache<AircraftDetails | null>(AIRCRAFT_TTL_MS, CACHE_CAP);
export const routeCache = new ExpiryCache<FlightrouteDetails | null>(ROUTE_TTL_MS, CACHE_CAP);

const inflightAircraft = new Map<string, Promise<AircraftDetails | null>>();
const inflightRoute = new Map<string, Promise<FlightrouteDetails | null>>();

export async function fetchAircraft(hex: string, baseUrl = 'https://api.adsbdb.com'): Promise<AircraftDetails | null> {
  const key = hex.toLowerCase();
  const cached = aircraftCache.get(key);
  if (cached.hit) return cached.val ?? null;

  const pending = inflightAircraft.get(key);
  if (pending) return pending;

  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADS_B_DB_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v0/aircraft/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'photoscout/0.1' },
        signal: controller.signal,
      });
      if (res.status === 404) {
        aircraftCache.set(key, null);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = parseAircraft(data);
      aircraftCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inflightAircraft.delete(key);
    }
  })();

  inflightAircraft.set(key, p);
  return p;
}

export async function fetchFlightroute(callsign: string, baseUrl = 'https://api.adsbdb.com'): Promise<FlightrouteDetails | null> {
  const key = callsign.toUpperCase();
  const cached = routeCache.get(key);
  if (cached.hit) return cached.val ?? null;

  const pending = inflightRoute.get(key);
  if (pending) return pending;

  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADS_B_DB_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v0/callsign/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'photoscout/0.1' },
        signal: controller.signal,
      });
      if (res.status === 404) {
        routeCache.set(key, null);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = parseFlightroute(data);
      routeCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inflightRoute.delete(key);
    }
  })();

  inflightRoute.set(key, p);
  return p;
}

/** Lazy aircraft and route enrichment via adsbdb.com. Returns null fields when unknown. */
export async function fetchPlaneInfo(
  hex: string,
  callsign?: string | null,
  baseUrl = process.env.ADS_B_DB_URL ?? 'https://api.adsbdb.com'
): Promise<PlaneInfo> {
  const [aircraft, route] = await Promise.all([
    fetchAircraft(hex, baseUrl),
    callsign ? fetchFlightroute(callsign, baseUrl) : Promise.resolve(null),
  ]);

  return {
    type: aircraft?.type ?? null,
    manufacturer: aircraft?.manufacturer ?? null,
    registration: aircraft?.registration ?? null,
    owner: aircraft?.owner ?? null,
    airline: route?.airline ?? null,
    origin: route?.origin ?? null,
    destination: route?.destination ?? null,
  };
}
