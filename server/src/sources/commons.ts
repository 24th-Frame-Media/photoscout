/** Wikimedia Commons geosearch: photos taken near a spot, for inspiration. Cached 1 day. */
import { Db } from '../db.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'photoscout/0.1';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 3600_000;

export interface CommonsImage {
  title: string;
  pageUrl: string;
  thumbUrl: string | null;
  lat: number;
  lng: number;
  focal35?: number | null;
  focalRaw?: number | null;
  takenAt?: string | null;
  model?: string | null;
}

export type LensBucketKey = 'ultra-wide' | 'wide' | 'standard' | 'tele' | 'super-tele';

export interface LensBucket {
  key: LensBucketKey;
  label: string;
  count: number;
  pct: number;
}

export interface LensStats {
  total: number;
  buckets: LensBucket[];
  byCategory: Record<LensBucketKey, LensBucket>;
  hours: number[]; // 24 bins for hours 0..23
  peakWindow: string | null;
  summary: string;
}

export interface PhotoLensInput {
  focal35?: number | string | null;
  focalRaw?: number | string | null;
  takenAt?: string | null;
}

interface GeosearchResult { title: string; lat: number; lon: number }
interface ImageInfoPage {
  title: string;
  imageinfo?: {
    thumburl?: string;
    descriptionurl?: string;
    commonmetadata?: { name: string; value: unknown }[];
  }[];
}

/** Parse a rational number like "420/10" or "50", returning positive float or null. */
export function parseRational(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return null;
    const slashIdx = s.indexOf('/');
    if (slashIdx !== -1) {
      const num = parseFloat(s.slice(0, slashIdx));
      const den = parseFloat(s.slice(slashIdx + 1));
      if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
        const res = num / den;
        return Number.isFinite(res) && res > 0 ? res : null;
      }
      return null;
    }
    const num = parseFloat(s);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

/** Extract metadata fields from Commons commonmetadata array. */
export function extractCommonMetadata(meta: { name: string; value: unknown }[] | undefined): {
  focalRaw: number | null;
  focal35: number | null;
  takenAt: string | null;
  model: string | null;
} {
  if (!Array.isArray(meta)) {
    return { focalRaw: null, focal35: null, takenAt: null, model: null };
  }
  const byName = new Map<string, unknown>();
  for (const m of meta) {
    if (m && typeof m.name === 'string') {
      byName.set(m.name.toLowerCase(), m.value);
    }
  }

  const rawVal = byName.get('focallength');
  const f35Val = byName.get('focallengthin35mmfilm');
  const dtVal = byName.get('datetimeoriginal');
  const modelVal = byName.get('model');

  return {
    focalRaw: parseRational(rawVal),
    focal35: parseRational(f35Val),
    takenAt: dtVal != null ? String(dtVal).trim() || null : null,
    model: modelVal != null ? String(modelVal).trim() || null : null,
  };
}

/** Assign effective focal length to a category bucket. */
export function focalBucket(focal: number): LensBucketKey {
  const f = Math.round(focal);
  if (f < 24) return 'ultra-wide';
  if (f <= 35) return 'wide';
  if (f <= 70) return 'standard';
  if (f <= 200) return 'tele';
  return 'super-tele';
}

/** Extract local hour (0-23) from DateTimeOriginal without timezone shifts. */
export function extractHour(takenAt: string | null | undefined): number | null {
  if (!takenAt || typeof takenAt !== 'string') return null;
  if (takenAt.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(takenAt)) {
    const d = new Date(takenAt);
    if (!Number.isNaN(d.getTime())) return d.getHours();
  }
  const m = takenAt.match(/(?:^|[T\s])(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return h >= 0 && h < 24 ? h : null;
}

/** Find the 2-hour window with the highest concentration of photos (e.g. "17:00-19:00"). */
export function peakHourWindow(hours: number[]): string | null {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let bestH = 0;
  let bestScore = -1;
  for (let h = 0; h < 23; h++) {
    const sum = hours[h] + hours[h + 1];
    // Score prioritises total count in window, with tie-break favoring earliest active hour
    const score = sum * 1000 + hours[h];
    if (score > bestScore) {
      bestScore = score;
      bestH = h;
    }
  }
  if (bestScore <= 0) return null;
  const start = String(bestH).padStart(2, '0');
  const end = String(bestH + 2).padStart(2, '0');
  return `${start}:00-${end}:00`;
}

/** Human-readable single-line summary of lens usage and peak shooting time. */
export function describeLensStats(stats: LensStats | null): string | null {
  if (!stats || stats.total < 3) return null;
  const parts: string[] = [];
  const activeBuckets = [...stats.buckets]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);
  for (const b of activeBuckets) {
    parts.push(`${b.pct}% ${b.label}`);
  }
  if (stats.peakWindow) {
    parts.push(`mostly ${stats.peakWindow}`);
  }
  if (!parts.length) return null;
  return `Lenses used here (n=${stats.total}): ${parts.join(' · ')}`;
}

/**
 * Pure lens stats from Commons and own photo EXIF:
 * effective focal = focal35 ?? (focalRaw >= 10 ? focalRaw : null)
 * (raw under 10 mm = phone/compact without 35mm equivalent, drop it).
 * Buckets: <24 ultra-wide, 24-35 wide, 36-70 standard, 71-200 tele, >200 super-tele.
 * Return null if fewer than 3 usable photos.
 */
export function lensStats(photos: PhotoLensInput[]): LensStats | null {
  const usable: { focal: number; takenAt: string | null }[] = [];
  for (const p of photos) {
    const f35 = parseRational(p.focal35);
    const fRaw = parseRational(p.focalRaw);
    const effective = f35 ?? (fRaw != null && fRaw >= 10 ? fRaw : null);
    if (effective != null) {
      usable.push({ focal: effective, takenAt: p.takenAt ?? null });
    }
  }

  if (usable.length < 3) return null;

  const total = usable.length;
  const counts: Record<LensBucketKey, number> = {
    'ultra-wide': 0,
    'wide': 0,
    'standard': 0,
    'tele': 0,
    'super-tele': 0,
  };
  const hours = new Array(24).fill(0);

  for (const u of usable) {
    const b = focalBucket(u.focal);
    counts[b]++;
    const h = extractHour(u.takenAt);
    if (h != null) hours[h]++;
  }

  const defs: { key: LensBucketKey; label: string }[] = [
    { key: 'tele', label: 'tele 71-200' },
    { key: 'standard', label: 'standard' },
    { key: 'wide', label: 'wide' },
    { key: 'ultra-wide', label: 'ultra-wide' },
    { key: 'super-tele', label: 'super-tele' },
  ];

  const buckets: LensBucket[] = defs.map((d) => ({
    key: d.key,
    label: d.label,
    count: counts[d.key],
    pct: Math.round((counts[d.key] / total) * 100),
  }));

  const byCategory = {} as Record<LensBucketKey, LensBucket>;
  for (const b of buckets) {
    byCategory[b.key] = b;
    (buckets as any)[b.key] = b;
  }

  const peakWindow = peakHourWindow(hours);
  const tempStats: LensStats = { total, buckets, byCategory, hours, peakWindow, summary: '' };
  tempStats.summary = describeLensStats(tempStats) || '';

  return tempStats;
}

async function commonsFetch(params: Record<string, string>): Promise<any> {
  const url = new URL(COMMONS_API);
  for (const [k, v] of Object.entries({ format: 'json', ...params })) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`Commons returned ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCommonsNearby(lat: number, lng: number, radiusM = 1000, limit = 20): Promise<CommonsImage[]> {
  const geo = await commonsFetch({
    action: 'query', list: 'geosearch', gsnamespace: '6', gscoord: `${lat}|${lng}`, gsradius: String(radiusM), gslimit: String(limit),
  });
  const results = (geo?.query?.geosearch ?? []) as GeosearchResult[];
  if (!results.length) return [];

  const info = await commonsFetch({
    action: 'query',
    titles: results.map((r) => r.title).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|commonmetadata',
    iimetadataversion: 'latest',
    iiurlwidth: '400',
  });
  const pages = Object.values(info?.query?.pages ?? {}) as ImageInfoPage[];
  const thumbByTitle = new Map(pages.map((p) => [p.title, p.imageinfo?.[0]]));

  return results.map((r) => {
    const ii = thumbByTitle.get(r.title);
    const meta = extractCommonMetadata(ii?.commonmetadata);
    return {
      title: r.title.replace(/^File:/, ''),
      pageUrl: ii?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(r.title)}`,
      thumbUrl: ii?.thumburl ?? null,
      lat: r.lat,
      lng: r.lon,
      focal35: meta.focal35,
      focalRaw: meta.focalRaw,
      takenAt: meta.takenAt,
      model: meta.model,
    };
  });
}

const cacheKey = (lat: number, lng: number) => `commons:v2:${lat.toFixed(4)},${lng.toFixed(4)}`;

export async function commonsNearbyCached(db: Db, lat: number, lng: number): Promise<CommonsImage[]> {
  const key = cacheKey(lat, lng);
  const raw = db.getKv(key);
  if (raw) return JSON.parse(raw) as CommonsImage[];
  try {
    const images = await fetchCommonsNearby(lat, lng);
    db.setKv(key, JSON.stringify(images), new Date(Date.now() + CACHE_TTL_MS).toISOString());
    return images;
  } catch {
    return [];
  }
}
