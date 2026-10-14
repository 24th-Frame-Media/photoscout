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

export interface OpenAipRunway {
  id?: string;
  designator?: string;
  surface?: string | number | Record<string, unknown>;
  lengthM?: number;
  widthM?: number;
  thresholdEndpoints?: [GeoJSON.Position, GeoJSON.Position];
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
  runways?: OpenAipRunway[];
  runwayGeometryUnavailable?: boolean;
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

function isValidCoordinate(coord: unknown): coord is [number, number] {
  if (!Array.isArray(coord) || coord.length < 2) return false;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return true;
}

function areDistinctCoordinates(c1: [number, number], c2: [number, number]): boolean {
  return c1[0] !== c2[0] || c1[1] !== c2[1];
}

function extractThresholdCoord(item: Record<string, unknown>): [number, number] | null {
  if (!item || typeof item !== 'object') return null;
  const loc = item.thresholdLocation as Record<string, unknown> | undefined;
  if (!loc || typeof loc !== 'object') return null;
  const geom = (loc.geometry as Record<string, unknown> | undefined) || loc;
  if (!geom || typeof geom !== 'object') return null;
  const coords = geom.coordinates;
  if (isValidCoordinate(coords)) {
    return [Number(coords[0]), Number(coords[1])];
  }
  return null;
}

export function reciprocalDesignator(designator: string): string | null {
  if (typeof designator !== 'string') return null;
  const trimmed = designator.trim().toUpperCase();
  const match = trimmed.match(/^(\d{1,2})([LCR])?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  if (num < 1 || num > 36) return null;
  const recipNum = num <= 18 ? num + 18 : num - 18;
  const recipNumStr = recipNum < 10 && match[1].startsWith('0') ? `0${recipNum}` : `${recipNum}`;
  const letter = match[2];
  let recipLetter = '';
  if (letter === 'L') recipLetter = 'R';
  else if (letter === 'R') recipLetter = 'L';
  else if (letter === 'C') recipLetter = 'C';
  return `${recipNumStr}${recipLetter}`;
}

export function normalizeRunways(
  rawRunways: unknown,
  isControlled?: boolean
): { runways?: OpenAipRunway[]; runwayGeometryUnavailable?: boolean } {
  if (!Array.isArray(rawRunways) || rawRunways.length === 0) {
    return {
      runways: undefined,
      runwayGeometryUnavailable: isControlled ? true : undefined,
    };
  }

  const normalized: OpenAipRunway[] = [];
  const consumedIndices = new Set<number>();

  // Pass 1: Look for items with explicit paired threshold coordinates already in the item
  for (let i = 0; i < rawRunways.length; i++) {
    const raw = rawRunways[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item._id === 'string' ? item._id : typeof item.id === 'string' ? item.id : undefined;
    const designator = typeof item.designator === 'string' ? item.designator : undefined;
    const surface = item.surface as OpenAipRunway['surface'];
    const lengthM =
      typeof item.lengthM === 'number'
        ? item.lengthM
        : typeof (item.dimension as any)?.length?.value === 'number'
          ? (item.dimension as any).length.value
          : undefined;
    const widthM =
      typeof item.widthM === 'number'
        ? item.widthM
        : typeof (item.dimension as any)?.width?.value === 'number'
          ? (item.dimension as any).width.value
          : undefined;

    // Direct thresholdEndpoints or endpoints array
    const candidateEndpoints = item.thresholdEndpoints || item.endpoints;
    if (Array.isArray(candidateEndpoints) && candidateEndpoints.length === 2) {
      const [c1, c2] = candidateEndpoints;
      if (isValidCoordinate(c1) && isValidCoordinate(c2) && areDistinctCoordinates(c1, c2)) {
        consumedIndices.add(i);
        normalized.push({
          id,
          designator,
          surface,
          lengthM,
          widthM,
          thresholdEndpoints: [
            [Number(c1[0]), Number(c1[1])],
            [Number(c2[0]), Number(c2[1])],
          ],
        });
        continue;
      }
    }

    // Two thresholds in item via thresholdLocation + oppositeThresholdLocation
    const t1 = extractThresholdCoord(item);
    const opp = item.oppositeThresholdLocation || item.reciprocalThresholdLocation;
    let t2: [number, number] | null = null;
    if (opp && typeof opp === 'object') {
      const oppGeom = (opp as any).geometry || opp;
      if (isValidCoordinate((oppGeom as any).coordinates)) {
        t2 = [(oppGeom as any).coordinates[0], (oppGeom as any).coordinates[1]];
      }
    }

    if (t1 && t2 && areDistinctCoordinates(t1, t2)) {
      consumedIndices.add(i);
      normalized.push({
        id,
        designator,
        surface,
        lengthM,
        widthM,
        thresholdEndpoints: [t1, t2],
      });
    }
  }

  // Pass 2: Pair unconsumed reciprocal runway items with explicit thresholdLocation
  for (let i = 0; i < rawRunways.length; i++) {
    if (consumedIndices.has(i)) continue;
    const rawA = rawRunways[i];
    if (!rawA || typeof rawA !== 'object') continue;
    const itemA = rawA as Record<string, unknown>;
    const desA = typeof itemA.designator === 'string' ? itemA.designator : null;
    if (!desA) continue;

    const recipA = reciprocalDesignator(desA);
    if (!recipA) continue;

    let matchedIdx = -1;
    for (let j = 0; j < rawRunways.length; j++) {
      if (i === j || consumedIndices.has(j)) continue;
      const rawB = rawRunways[j];
      if (!rawB || typeof rawB !== 'object') continue;
      const itemB = rawB as Record<string, unknown>;
      const desB = typeof itemB.designator === 'string' ? itemB.designator : null;
      if (desB && desB.trim().toUpperCase() === recipA) {
        matchedIdx = j;
        break;
      }
    }

    if (matchedIdx !== -1) {
      const itemB = rawRunways[matchedIdx] as Record<string, unknown>;
      const coordA = extractThresholdCoord(itemA);
      const coordB = extractThresholdCoord(itemB);

      if (coordA && coordB && areDistinctCoordinates(coordA, coordB)) {
        consumedIndices.add(i);
        consumedIndices.add(matchedIdx);

        const idA = typeof itemA._id === 'string' ? itemA._id : typeof itemA.id === 'string' ? itemA.id : undefined;
        const idB = typeof itemB._id === 'string' ? itemB._id : typeof itemB.id === 'string' ? itemB.id : undefined;
        const pairId = idA && idB ? `${idA}/${idB}` : idA || idB;
        const pairDesignator = `${desA}/${itemB.designator}`;

        const lengthM =
          typeof itemA.lengthM === 'number'
            ? itemA.lengthM
            : typeof (itemA.dimension as any)?.length?.value === 'number'
              ? (itemA.dimension as any).length.value
              : typeof itemB.lengthM === 'number'
                ? itemB.lengthM
                : undefined;
        const widthM =
          typeof itemA.widthM === 'number'
            ? itemA.widthM
            : typeof (itemA.dimension as any)?.width?.value === 'number'
              ? (itemA.dimension as any).width.value
              : typeof itemB.widthM === 'number'
                ? itemB.widthM
                : undefined;

        normalized.push({
          id: pairId,
          designator: pairDesignator,
          surface: (itemA.surface || itemB.surface) as OpenAipRunway['surface'],
          lengthM,
          widthM,
          thresholdEndpoints: [coordA, coordB],
        });
      }
    }
  }

  // Pass 3: Preserve remaining items metadata without thresholdEndpoints
  for (let i = 0; i < rawRunways.length; i++) {
    if (consumedIndices.has(i)) continue;
    const raw = rawRunways[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item._id === 'string' ? item._id : typeof item.id === 'string' ? item.id : undefined;
    const designator = typeof item.designator === 'string' ? item.designator : undefined;
    const surface = item.surface as OpenAipRunway['surface'];
    const lengthM =
      typeof item.lengthM === 'number'
        ? item.lengthM
        : typeof (item.dimension as any)?.length?.value === 'number'
          ? (item.dimension as any).length.value
          : undefined;
    const widthM =
      typeof item.widthM === 'number'
        ? item.widthM
        : typeof (item.dimension as any)?.width?.value === 'number'
          ? (item.dimension as any).width.value
          : undefined;

    normalized.push({
      id,
      designator,
      surface,
      lengthM,
      widthM,
    });
  }

  const hasAnyValidGeometry = normalized.some((r) => r.thresholdEndpoints != null);
  const runwayGeometryUnavailable = isControlled ? !hasAnyValidGeometry : undefined;

  return {
    runways: normalized.length > 0 ? normalized : undefined,
    runwayGeometryUnavailable,
  };
}

function parseAirportItem(raw: unknown): OpenAipAirport | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item._id === 'string' ? item._id : typeof item.id === 'string' ? item.id : null;
  if (!id) return null;

  const geometry = item.geometry as GeoJSON.Point | undefined;
  if (!geometry || typeof geometry !== 'object' || geometry.type !== 'Point') return null;

  const controlled = typeof item.controlled === 'boolean' ? item.controlled : undefined;
  const { runways, runwayGeometryUnavailable } = normalizeRunways(item.runways, controlled);

  return {
    id,
    name: typeof item.name === 'string' ? item.name : 'Airport',
    icaoCode: typeof item.icaoCode === 'string' ? item.icaoCode : undefined,
    iataCode: typeof item.iataCode === 'string' ? item.iataCode : undefined,
    type: item.type != null ? (item.type as number | string) : undefined,
    controlled,
    geometry,
    runways,
    runwayGeometryUnavailable,
    frequencies: Array.isArray(item.frequencies) ? (item.frequencies as OpenAipAirport['frequencies']) : undefined,
  };
}
