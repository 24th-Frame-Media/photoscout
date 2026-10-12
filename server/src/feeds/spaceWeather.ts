/** NOAA Space Weather planetary K-index (Kp) feed. Cached for 30 min, stale-on-error. */

export interface AuroraForecast {
  kpNow: number | null;
  kpMaxNext24h: number | null;
}

function parseEntry(row: unknown, headers?: string[]): { time: number; kp: number } | null {
  if (!row) return null;
  let timeStr = '';
  let kpVal: unknown = undefined;

  if (Array.isArray(row) && headers) {
    const tIdx = headers.indexOf('time_tag');
    const kIdx = headers.findIndex((h) => /^kp$/i.test(h));
    if (tIdx >= 0) timeStr = String(row[tIdx]);
    if (kIdx >= 0) kpVal = row[kIdx];
  } else if (typeof row === 'object') {
    const obj = row as Record<string, unknown>;
    timeStr = String(obj.time_tag ?? obj.timeTag ?? '');
    kpVal = obj.Kp ?? obj.kp;
  }

  if (!timeStr) return null;
  const numKp = typeof kpVal === 'number' ? kpVal : parseFloat(String(kpVal));
  if (!Number.isFinite(numKp)) return null;

  const d = new Date(timeStr.endsWith('Z') ? timeStr : `${timeStr}Z`);
  const time = d.getTime();
  if (Number.isNaN(time)) return null;

  return { time, kp: numKp };
}

function extractEntries(raw: unknown): { time: number; kp: number }[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const entries: { time: number; kp: number }[] = [];

  let headers: string[] | undefined = undefined;
  let startIdx = 0;
  if (Array.isArray(raw[0]) && typeof raw[0][0] === 'string') {
    headers = raw[0].map((h: unknown) => String(h).toLowerCase());
    startIdx = 1;
  }

  for (let i = startIdx; i < raw.length; i++) {
    const parsed = parseEntry(raw[i], headers);
    if (parsed) entries.push(parsed);
  }

  return entries;
}

/** Pure parser for NOAA observed and forecast Kp data. */
export function parseAurora(observedRaw: unknown, forecastRaw: unknown, now = Date.now()): AuroraForecast {
  const observed = extractEntries(observedRaw);
  const forecast = extractEntries(forecastRaw);

  let kpNow: number | null = null;
  if (observed.length > 0) {
    // Find the latest observation at or before now, or simply the last entry if recent
    const past = observed.filter((e) => e.time <= now);
    const latest = past.length > 0 ? past[past.length - 1] : observed[observed.length - 1];
    kpNow = Math.round(latest.kp * 100) / 100;
  }

  let kpMaxNext24h: number | null = null;
  const next24h = forecast.filter((e) => e.time >= now && e.time <= now + 24 * 3_600_000);
  if (next24h.length > 0) {
    const maxVal = Math.max(...next24h.map((e) => e.kp));
    kpMaxNext24h = Math.round(maxVal * 100) / 100;
  } else if (forecast.length > 0) {
    const future = forecast.filter((e) => e.time >= now);
    const pool = future.length > 0 ? future : forecast;
    kpMaxNext24h = Math.round(Math.max(...pool.map((e) => e.kp)) * 100) / 100;
  } else if (kpNow != null) {
    kpMaxNext24h = kpNow;
  }

  return { kpNow, kpMaxNext24h };
}

const KP_OBSERVED_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const KP_FORECAST_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60_000;

let cache: { at: number; data: AuroraForecast } | null = null;
let inflight: Promise<AuroraForecast> | null = null;

export async function fetchAurora(
  observedUrl = KP_OBSERVED_URL,
  forecastUrl = KP_FORECAST_URL,
): Promise<AuroraForecast> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const [obsRes, fcRes] = await Promise.all([
        fetch(observedUrl, {
          headers: { 'User-Agent': 'photoscout/0.1' },
          signal: controller.signal,
        }),
        fetch(forecastUrl, {
          headers: { 'User-Agent': 'photoscout/0.1' },
          signal: controller.signal,
        }).catch(() => null),
      ]);

      if (!obsRes.ok) throw new Error(`NOAA Kp observed returned ${obsRes.status}`);
      const obsJson = await obsRes.json();
      const fcJson = fcRes && fcRes.ok ? await fcRes.json().catch(() => null) : null;

      const data = parseAurora(obsJson, fcJson);
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
