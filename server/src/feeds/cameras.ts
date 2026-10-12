/** TfNSW Live Traffic cameras feed (weather ground-truth). Cached for 10 min, stale-on-error. */

export interface TrafficCamera {
  id: string;
  title: string;
  view: string;
  direction: string;
  region: string;
  imageUrl: string;
  point: [number, number];
}

/** Pure parser for TfNSW live traffic cameras GeoJSON into normalized camera records. */
export function parseCameras(raw: unknown): TrafficCamera[] {
  if (!raw || typeof raw !== 'object') return [];
  const features = (raw as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];

  const out: TrafficCamera[] = [];
  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const feat = f as {
      id?: string | number;
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };

    const geom = feat.geometry;
    if (!geom || typeof geom.type !== 'string' || geom.type.toLowerCase() !== 'point' || !Array.isArray(geom.coordinates)) {
      continue;
    }
    const coords = geom.coordinates;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      continue;
    }

    const p = feat.properties ?? {};
    const id = String(feat.id ?? p.id ?? '').trim() || String(out.length + 1);
    const title = String(p.title ?? '').trim();
    const view = String(p.view ?? '').trim();
    const direction = String(p.direction ?? '').trim();
    const region = String(p.region ?? '').trim();
    const imageUrl = String(p.href ?? p.imageUrl ?? p.image_url ?? '').trim();

    out.push({
      id,
      title,
      view,
      direction,
      region,
      imageUrl,
      point: [lng, lat],
    });
  }

  return out;
}

export const CAMERAS_FEED_URL = 'https://api.transport.nsw.gov.au/v1/live/cameras';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;

let cache: { at: number; key: string; data: TrafficCamera[] } | null = null;
let inflight: Promise<TrafficCamera[]> | null = null;

export function clearCameraCache(): void {
  cache = null;
  inflight = null;
}

export function setCameraCacheForTest(key: string, data: TrafficCamera[], at: number): void {
  cache = { at, key, data };
}

export async function fetchCameras(apiKey: string, url = CAMERAS_FEED_URL): Promise<TrafficCamera[]> {
  if (cache && cache.key === apiKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `apikey ${apiKey}`,
          'User-Agent': 'photoscout/0.1',
        },
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        const err = new Error('not authorised: add the Live Traffic product to your TfNSW key');
        (err as any).status = 403;
        throw err;
      }
      if (!res.ok) {
        throw new Error(`TfNSW cameras returned ${res.status}`);
      }

      const json = await res.json();
      const data = parseCameras(json);
      cache = { at: Date.now(), key: apiKey, data };
      return data;
    } catch (err) {
      if ((err as Error).message.includes('not authorised')) {
        throw err;
      }
      if (cache && cache.key === apiKey) {
        return cache.data; // stale beats nothing
      }
      throw err;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}
