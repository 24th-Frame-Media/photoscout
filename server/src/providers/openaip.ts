import type { Db } from '../db.js';
import { getUserApiKey } from '../userApiKeys.js';

export const OPENAIP_BASE_URL = 'https://api.core.openaip.net/api';
export const DEFAULT_CACHE_TTL_MS = 15 * 60_000; // 15 minutes
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RADIUS_M = 50_000; // 50 km
export const MAX_BBOX_SPAN_DEG = 1.0; // 1.0 degree max span (~111 km)
export const DEFAULT_MAX_PAGES = 5;
export const OPENAIP_ATTRIBUTION = 'Data provided by openAIP (CC BY-NC-SA 4.0)';

export interface OpenAipAirspace {
  id: string;
  name: string;
  type: number | string;
  typeName: string;
  icaoClass?: string;
  activity?: number | string;
  lowerLimit?: {
    value: number;
    unit?: string | number;
    referenceDatum?: string | number;
  };
  upperLimit?: {
    value: number;
    unit?: string | number;
    referenceDatum?: string | number;
  };
  geometry: GeoJSON.Geometry;
}

export interface OpenAipAirport {
  id: string;
  name: string;
  icaoCode?: string;
  iataCode?: string;
  type?: number | string;
  typeName?: string;
  controlled?: boolean;
  geometry: GeoJSON.Point;
  runways?: Array<{
    designator?: string;
    surface?: string | number;
    lengthM?: number;
  }>;
  frequencies?: Array<{
    type?: string;
    frequency?: string;
    name?: string;
  }>;
}

export interface OpenAipContextData {
  airspaces: OpenAipAirspace[];
  airports: OpenAipAirport[];
}

export interface OpenAipSourceMeta {
  provider: 'openaip';
  endpoint: string;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
  attribution: string;
}

export type OpenAipResult =
  | {
      status: 'not_configured';
      message: string;
    }
  | {
      status: 'ok' | 'stale';
      data: OpenAipContextData;
      source: OpenAipSourceMeta;
    }
  | {
      status: 'error';
      error: string;
      source?: OpenAipSourceMeta;
    };

export interface FetchOpenAipOptions {
  db?: Db;
  userId?: string;
  apiKey?: string;
  lat?: number;
  lng?: number;
  radiusM?: number;
  bbox?: [number, number, number, number];
  fetchFn?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  maxPages?: number;
  timeoutMs?: number;
}

export function normalizeAirspaceType(type: number | string): string {
  if (typeof type === 'string') return type.toUpperCase();
  // OpenAIP Core schema's documented airspace type enum.
  switch (type) {
    case 0:
      return 'OTHER';
    case 1:
      return 'RESTRICTED';
    case 2:
      return 'DANGER';
    case 3:
      return 'PROHIBITED';
    case 4:
      return 'CTR';
    case 7:
      return 'TMA';
    case 17:
      return 'ALERT';
    case 18:
      return 'WARNING';
    case 26:
      return 'CTA';
    default:
      return `AIRSPACE_${type}`;
  }
}

export function boundsFromPointRadius(
  lat: number,
  lng: number,
  radiusM: number
): [number, number, number, number] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusM)) {
    throw new Error('Coordinates and radius must be finite numbers');
  }
  if (lat < -90 || lat > 90) {
    throw new Error('Latitude must be between -90 and 90');
  }
  if (lng < -180 || lng > 180) {
    throw new Error('Longitude must be between -180 and 180');
  }
  if (radiusM <= 0) {
    throw new Error('Radius must be positive');
  }
  if (radiusM > MAX_RADIUS_M) {
    throw new Error(`Radius exceeds maximum allowed limit of ${MAX_RADIUS_M} m`);
  }

  const deltaLat = radiusM / 111_000;
  const rad = (lat * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(rad), 0.01);
  const deltaLng = radiusM / (111_000 * cosLat);

  const minLat = Math.max(-90, lat - deltaLat);
  const maxLat = Math.min(90, lat + deltaLat);
  const minLng = Math.max(-180, lng - deltaLng);
  const maxLng = Math.min(180, lng + deltaLng);

  return [minLng, minLat, maxLng, maxLat];
}

function validateAndNormalizeBbox(
  options: FetchOpenAipOptions
): [number, number, number, number] {
  let bbox = options.bbox;
  if (!bbox) {
    if (options.lat == null || options.lng == null) {
      throw new Error('Either bbox or lat/lng must be provided');
    }
    const radius = options.radiusM ?? 5000;
    bbox = boundsFromPointRadius(options.lat, options.lng, radius);
  }

  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (
    !Number.isFinite(minLng) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLng) ||
    !Number.isFinite(maxLat)
  ) {
    throw new Error('All bounding box coordinates must be finite numbers');
  }
  if (minLat < -90 || maxLat > 90 || minLat > maxLat) {
    throw new Error('Latitude must be between -90 and 90 and minLat <= maxLat');
  }
  if (minLng < -180 || maxLng > 180 || minLng > maxLng) {
    throw new Error('Longitude must be between -180 and 180 and minLng <= maxLng');
  }
  if (maxLat - minLat > MAX_BBOX_SPAN_DEG || maxLng - minLng > MAX_BBOX_SPAN_DEG) {
    throw new Error(`Bounding box extent exceeds maximum allowed span of ${MAX_BBOX_SPAN_DEG} degrees`);
  }

  return [minLng, minLat, maxLng, maxLat];
}

function redactSecret(str: string, secret?: string | null): string {
  if (!secret) return str;
  return str.split(secret).join('[REDACTED]');
}

interface StoredCacheEntry {
  fetchedAt: string;
  expiresAt: string;
  attribution: string;
  data: OpenAipContextData;
}

export async function fetchOpenAipContext(
  options: FetchOpenAipOptions
): Promise<OpenAipResult> {
  const { db, userId } = options;

  let apiKey: string | null = options.apiKey ?? null;
  if (!apiKey && db && userId) {
    apiKey = getUserApiKey(db, userId, 'openaip');
  }

  if (!apiKey) {
    return {
      status: 'not_configured',
      message: 'OpenAIP API key not configured for user',
    };
  }

  const bbox = validateAndNormalizeBbox(options);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const bboxStr = `${minLng.toFixed(4)},${minLat.toFixed(4)},${maxLng.toFixed(4)},${maxLat.toFixed(4)}`;
  const cacheKey = `openaip:cache:${bboxStr}`;

  const getTime = options.now ?? (() => Date.now());
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const fetchFn = options.fetchFn ?? fetch;

  let cachedEntry: StoredCacheEntry | null = null;
  if (db) {
    const rawCache = db.getKv(cacheKey);
    if (rawCache) {
      try {
        cachedEntry = JSON.parse(rawCache) as StoredCacheEntry;
      } catch {
        // Corrupted cache - proceed to fetch
      }
    }
  }

  const nowMs = getTime();
  if (cachedEntry && nowMs <= Date.parse(cachedEntry.expiresAt)) {
    return {
      status: 'ok',
      data: cachedEntry.data,
      source: {
        provider: 'openaip',
        endpoint: '/airspaces,/airports',
        fetchedAt: cachedEntry.fetchedAt,
        expiresAt: cachedEntry.expiresAt,
        stale: false,
        attribution: cachedEntry.attribution,
      },
    };
  }

  // Attempt fetch upstream
  try {
    const airspaces = await fetchOpenAipLayer<OpenAipAirspace>({
      layer: 'airspaces',
      bbox,
      apiKey,
      fetchFn,
      timeoutMs,
      maxPages,
      parseItem: parseAirspaceItem,
    });

    const airports = await fetchOpenAipLayer<OpenAipAirport>({
      layer: 'airports',
      bbox,
      apiKey,
      fetchFn,
      timeoutMs,
      maxPages,
      parseItem: parseAirportItem,
    });

    const fetchedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();

    const data: OpenAipContextData = { airspaces, airports };

    if (db) {
      const entryToCache: StoredCacheEntry = {
        fetchedAt,
        expiresAt,
        attribution: OPENAIP_ATTRIBUTION,
        data,
      };
      // Store in KV without SQLite expiration so stale entry remains recoverable on failure
      db.setKv(cacheKey, JSON.stringify(entryToCache), null);
    }

    return {
      status: 'ok',
      data,
      source: {
        provider: 'openaip',
        endpoint: '/airspaces,/airports',
        fetchedAt,
        expiresAt,
        stale: false,
        attribution: OPENAIP_ATTRIBUTION,
      },
    };
  } catch (err) {
    if (cachedEntry) {
      return {
        status: 'stale',
        data: cachedEntry.data,
        source: {
          provider: 'openaip',
          endpoint: '/airspaces,/airports',
          fetchedAt: cachedEntry.fetchedAt,
          expiresAt: cachedEntry.expiresAt,
          stale: true,
          attribution: cachedEntry.attribution,
        },
      };
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = redactSecret(rawMsg, apiKey);
    return {
      status: 'error',
      error: `OpenAIP request failed: ${safeMsg}`,
    };
  }
}

interface LayerFetchOptions<T> {
  layer: 'airspaces' | 'airports';
  bbox: [number, number, number, number];
  apiKey: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  maxPages: number;
  parseItem: (raw: unknown) => T | null;
}

async function fetchOpenAipLayer<T extends { id: string }>(
  opts: LayerFetchOptions<T>
): Promise<T[]> {
  const { layer, bbox, apiKey, fetchFn, timeoutMs, maxPages, parseItem } = opts;
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const bboxParam = `${minLng},${minLat},${maxLng},${maxLat}`;

  const itemsMap = new Map<string, T>();
  let page = 1;

  while (page <= maxPages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${OPENAIP_BASE_URL}/${layer}?bbox=${bboxParam}&page=${page}&limit=50`;
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          'x-openaip-api-key': apiKey,
          'Accept': 'application/json',
          'User-Agent': 'photoscout/0.1',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`OpenAIP ${layer} returned HTTP ${res.status}`);
      }

      const json = (await res.json()) as {
        items?: unknown[];
        totalPages?: number;
      };

      if (!json || !Array.isArray(json.items)) {
        break;
      }

      for (const raw of json.items) {
        const parsed = parseItem(raw);
        if (parsed && !itemsMap.has(parsed.id)) {
          itemsMap.set(parsed.id, parsed);
        }
      }

      const totalPages = typeof json.totalPages === 'number' ? json.totalPages : 1;
      if (page >= totalPages) {
        break;
      }
      page++;
    } finally {
      clearTimeout(timer);
    }
  }

  return Array.from(itemsMap.values());
}

function parseAirspaceItem(raw: unknown): OpenAipAirspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item._id === 'string' ? item._id : typeof item.id === 'string' ? item.id : null;
  if (!id) return null;

  const geometry = item.geometry as GeoJSON.Geometry | undefined;
  if (!geometry || typeof geometry !== 'object' || !geometry.type) return null;

  const rawType = item.type != null ? (item.type as number | string) : 'UNKNOWN';
  const typeName = normalizeAirspaceType(rawType);

  return {
    id,
    name: typeof item.name === 'string' ? item.name : 'Airspace',
    type: rawType,
    typeName,
    icaoClass: typeof item.icaoClass === 'string' ? item.icaoClass : undefined,
    activity: item.activity != null ? (item.activity as number | string) : undefined,
    lowerLimit: item.lowerLimit as OpenAipAirspace['lowerLimit'],
    upperLimit: item.upperLimit as OpenAipAirspace['upperLimit'],
    geometry,
  };
}

function parseAirportItem(raw: unknown): OpenAipAirport | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item._id === 'string' ? item._id : typeof item.id === 'string' ? item.id : null;
  if (!id) return null;

  const geometry = item.geometry as GeoJSON.Point | undefined;
  if (!geometry || typeof geometry !== 'object' || geometry.type !== 'Point') return null;

  return {
    id,
    name: typeof item.name === 'string' ? item.name : 'Airport',
    icaoCode: typeof item.icaoCode === 'string' ? item.icaoCode : undefined,
    iataCode: typeof item.iataCode === 'string' ? item.iataCode : undefined,
    type: item.type != null ? (item.type as number | string) : undefined,
    controlled: typeof item.controlled === 'boolean' ? item.controlled : undefined,
    geometry,
    runways: Array.isArray(item.runways) ? (item.runways as OpenAipAirport['runways']) : undefined,
    frequencies: Array.isArray(item.frequencies) ? (item.frequencies as OpenAipAirport['frequencies']) : undefined,
  };
}
