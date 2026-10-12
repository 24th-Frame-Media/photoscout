/** NSW Rural Fire Service major incidents feed (CC BY 4.0). Cached for 5 min, stale-on-error. */

export interface FireIncident {
  id: string;
  title: string;
  category: string;
  status: string;
  sizeHa?: number;
  updated: string;
  link: string;
  geometry: GeoJSON.Geometry;
}

/** Pure parser for RFS majorIncidents GeoJSON into simplified fire incidents. */
export function parseRfs(raw: unknown): FireIncident[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { features?: unknown }).features)) return [];
  const features = (raw as { features: unknown[] }).features;
  const out: FireIncident[] = [];

  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const feat = f as { id?: string | number; properties?: Record<string, unknown>; geometry?: GeoJSON.Geometry };
    if (!feat.geometry) continue;

    const p = feat.properties ?? {};
    const title = String(p.title ?? '').trim();
    const category = String(p.category ?? 'Not Applicable').trim();
    const desc = String(p.description ?? '');

    const statusMatch = desc.match(/STATUS:\s*([^<]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    const sizeMatch = desc.match(/SIZE:\s*([\d,.]+)\s*ha/i);
    const sizeHa = sizeMatch ? parseFloat(sizeMatch[1].replace(/,/g, '')) : undefined;

    const updatedMatch = desc.match(/UPDATED:\s*([^<]+)/i);
    const updated = updatedMatch ? updatedMatch[1].trim() : String(p.pubDate ?? '').trim();

    const link = String(p.link ?? '').trim();
    const guid = p.guid ? String(p.guid) : '';
    const id = guid ? guid.split('/').filter(Boolean).pop() || guid : String(feat.id ?? out.length);

    out.push({
      id,
      title,
      category,
      status,
      ...(sizeHa != null && Number.isFinite(sizeHa) ? { sizeHa } : {}),
      updated,
      link,
      geometry: feat.geometry,
    });
  }

  return out;
}

const RFS_FEED_URL = 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;

let cache: { at: number; data: FireIncident[] } | null = null;
let inflight: Promise<FireIncident[]> | null = null;

export async function fetchFires(url = RFS_FEED_URL): Promise<FireIncident[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'photoscout/0.1' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`RFS feed returned ${res.status}`);
      const json = await res.json();
      const data = parseRfs(json);
      cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (cache) return cache.data; // stale beats nothing
      throw err;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}
