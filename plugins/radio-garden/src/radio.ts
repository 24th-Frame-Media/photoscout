/**
 * Radio Garden, as the plugin serves it: the places feed, the stations of one
 * place, and the redirect to a station's stream. Moved from the server's
 * sources/radioGarden.ts. The cache lives in the plugin's own database (see
 * RadioKv), and every upstream call goes through the fetch the host gives us.
 */

export const RADIO_PLUGIN_ID = 'media.24thframe.radio-garden';

export interface RadioPlace {
  id: string;
  title: string;
  country: string;
  lng: number;
  lat: number;
  stationCount: number;
}

export interface RadioStation {
  id: string;
  title: string;
  placeId: string;
  streamDomain?: string;
  listenUrl: string;
}

export interface RadioPlaceDetails {
  placeId: string;
  title?: string;
  country?: string;
  stations: RadioStation[];
}

export class RadioProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'RadioProviderError';
    this.status = status;
  }
}

/** A string key-value store for the cache. */
export interface RadioKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type RadioFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Strict validation for Radio Garden place and channel IDs. Prevents path traversal and arbitrary proxying. */
export const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidRadioId(id: unknown): id is string {
  return typeof id === 'string' && ID_REGEX.test(id);
}

export const RADIO_PLACES_KEY = 'radio:places:v1';
export const PLACES_CACHE_TTL_MS = 24 * 3600_000; // 24 hours
export const STATIONS_CACHE_TTL_MS = 10 * 60_000; // 10 minutes

export const RADIO_PLACES_URL = 'https://radio.garden/api/ara/content/places';
export const radioPlaceUrl = (placeId: string) => `https://radio.garden/api/ara/content/page/${encodeURIComponent(placeId)}`;
/** Where a station's audio is asked for, as the browser sees it: this plugin's own route, same origin. */
export const radioListenPath = (channelId: string) => `/api/plugins/${RADIO_PLUGIN_ID}/stations/${encodeURIComponent(channelId)}/listen`;

export const PROVIDER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://radio.garden/',
  'Origin': 'https://radio.garden',
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PLACES_BYTES = 15 * 1024 * 1024; // 15 MB guard
const MAX_PAGE_BYTES = 3 * 1024 * 1024; // 3 MB guard

/** Resolves the upstream provider redirect URL for a channel. */
export function getProviderListenUrl(channelId: string): string {
  if (!isValidRadioId(channelId)) {
    throw new RadioProviderError('Invalid channel ID', 400);
  }
  return `https://radio.garden/api/ara/content/listen/${encodeURIComponent(channelId)}/channel.mp3`;
}

/**
 * Defensive parser for Radio Garden's global places feed.
 * Drops malformed rows, invalid coordinates, and missing IDs/titles.
 */
export function parseRadioPlaces(raw: unknown): RadioPlace[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as any).data?.list ?? (raw as any).list;
  if (!Array.isArray(list)) return [];

  const places: RadioPlace[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id;
    if (!isValidRadioId(id)) continue;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;

    const country = typeof item.country === 'string' ? item.country.trim() : '';

    if (!Array.isArray(item.geo) || item.geo.length < 2) continue;
    const lng = typeof item.geo[0] === 'number' ? item.geo[0] : parseFloat(String(item.geo[0]));
    const lat = typeof item.geo[1] === 'number' ? item.geo[1] : parseFloat(String(item.geo[1]));
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) continue;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;

    const size = typeof item.size === 'number' ? item.size : parseInt(String(item.size), 10);
    const stationCount = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;

    places.push({ id, title, country, lng, lat, stationCount });
  }

  return places;
}

/**
 * Parses station items from a place page payload.
 * Extracts channel ID from nested item.page, deduplicates channels,
 * and builds the listen URLs this plugin serves.
 */
export function parseRadioStations(raw: unknown, placeId: string): RadioPlaceDetails {
  if (!raw || typeof raw !== 'object') {
    return { placeId, stations: [] };
  }
  const data = (raw as any).data ?? raw;
  const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : undefined;
  const country = typeof data?.subtitle === 'string' && data.subtitle.trim() ? data.subtitle.trim() : undefined;
  const content = Array.isArray(data?.content) ? data.content : [];

  const byId = new Map<string, RadioStation>();

  for (const section of content) {
    if (!section || typeof section !== 'object') continue;
    const items = section.items;
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const page = item?.page;
      if (!page || typeof page !== 'object') continue;
      const url = typeof page.url === 'string' ? page.url : '';
      if (page.type !== 'channel' && !url.includes('/listen/')) continue;

      const urlParts = url.split('/');
      const channelId = urlParts[urlParts.length - 1];
      if (!isValidRadioId(channelId)) continue;

      const stationTitle = typeof page.title === 'string' && page.title.trim() ? page.title.trim() : '';
      if (!stationTitle) continue;

      const streamDomain = typeof page.stream === 'string' && page.stream.trim() ? page.stream.trim() : undefined;
      const stationPlaceId = typeof page.place?.id === 'string' && isValidRadioId(page.place.id)
        ? page.place.id
        : placeId;

      if (!byId.has(channelId)) {
        byId.set(channelId, {
          id: channelId,
          title: stationTitle,
          placeId: stationPlaceId,
          streamDomain,
          listenUrl: radioListenPath(channelId),
        });
      }
    }
  }

  return {
    placeId,
    title,
    country,
    stations: Array.from(byId.values()),
  };
}

/**
 * The body as text, read as it arrives. Once more than maxBytes have come, the
 * read stops and the connection is let go, so a huge answer is never held in memory.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RadioProviderError('Radio Garden response exceeded allowed size', 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchWithGuards(url: string, maxBytes: number, fetchFn: RadioFetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetchFn(url, {
      headers: PROVIDER_HEADERS,
      signal: controller.signal,
    });

    if (res.status === 404) {
      throw new RadioProviderError('Radio Garden place not found', 404);
    }
    if (!res.ok) {
      throw new RadioProviderError(`Radio Garden returned HTTP ${res.status}`, res.status >= 500 ? 503 : 502);
    }

    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new RadioProviderError('Radio Garden response exceeded allowed size', 502);
    }

    const text = await readCapped(res, maxBytes);

    try {
      return JSON.parse(text);
    } catch {
      throw new RadioProviderError('Malformed JSON from Radio Garden', 502);
    }
  } catch (err) {
    if (err instanceof RadioProviderError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new RadioProviderError('Radio Garden request timed out', 503);
    }
    // The network error's own text can name hosts and addresses; the client gets a fixed line instead.
    throw new RadioProviderError('Radio Garden could not be reached', 503);
  } finally {
    clearTimeout(timer);
  }
}

function readCached<T>(kv: RadioKv, key: string): { cachedAt: number; value: T } | null {
  const raw = kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as { cachedAt: number; value: T }) : null;
  } catch {
    return null; // ignore corrupt cache
  }
}

/**
 * Fetches and normalises the global Radio Garden places feed.
 * Caches in KV for 24 hours. Serves stale cached data if provider refresh fails.
 */
export async function fetchRadioPlaces(
  kv: RadioKv,
  options: { fetchFn: RadioFetch; forceRefresh?: boolean },
): Promise<RadioPlace[]> {
  const cached = readCached<RadioPlace[]>(kv, RADIO_PLACES_KEY);
  const parsedCached = cached && Array.isArray(cached.value) ? { cachedAt: cached.cachedAt, places: cached.value } : null;

  const isFresh =
    !options.forceRefresh &&
    parsedCached &&
    typeof parsedCached.cachedAt === 'number' &&
    Date.now() - parsedCached.cachedAt < PLACES_CACHE_TTL_MS;

  if (isFresh && parsedCached) {
    return parsedCached.places;
  }

  try {
    const json = await fetchWithGuards(RADIO_PLACES_URL, MAX_PLACES_BYTES, options.fetchFn);
    const places = parseRadioPlaces(json);
    if (!places.length) {
      throw new RadioProviderError('Malformed provider data: empty places list', 502);
    }

    kv.set(RADIO_PLACES_KEY, JSON.stringify({ cachedAt: Date.now(), value: places }));
    return places;
  } catch (err) {
    if (parsedCached && parsedCached.places.length > 0) {
      return parsedCached.places; // Stale beats nothing
    }
    throw err;
  }
}

const stationsCacheKey = (placeId: string) => `radio:stations:v1:${placeId}`;

/**
 * Fetches and shapes stations for one place on demand.
 * Caches in KV for 10 minutes. Serves stale cached data if provider refresh fails.
 */
export async function fetchRadioStations(
  kv: RadioKv,
  placeId: string,
  options: { fetchFn: RadioFetch; forceRefresh?: boolean },
): Promise<RadioPlaceDetails> {
  if (!isValidRadioId(placeId)) {
    throw new RadioProviderError('Invalid place ID', 400);
  }

  const key = stationsCacheKey(placeId);
  const cached = readCached<RadioPlaceDetails>(kv, key);
  const parsedCached = cached && cached.value ? { cachedAt: cached.cachedAt, details: cached.value } : null;

  const isFresh =
    !options.forceRefresh &&
    parsedCached &&
    typeof parsedCached.cachedAt === 'number' &&
    Date.now() - parsedCached.cachedAt < STATIONS_CACHE_TTL_MS;

  if (isFresh && parsedCached) {
    return parsedCached.details;
  }

  try {
    const url = radioPlaceUrl(placeId);
    const json = await fetchWithGuards(url, MAX_PAGE_BYTES, options.fetchFn);
    const details = parseRadioStations(json, placeId);

    kv.set(key, JSON.stringify({ cachedAt: Date.now(), value: details }));
    return details;
  } catch (err) {
    if (parsedCached) {
      return parsedCached.details; // Stale beats nothing
    }
    throw err;
  }
}
