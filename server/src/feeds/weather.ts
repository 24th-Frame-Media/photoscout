/** Open-Meteo hourly forecast (free, no key). Cached per 0.05° cell for 20 min, stale-on-error. */

export interface WeatherHour {
  time: string; // ISO (UTC)
  tempC: number | null;
  cloudPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipMm: number | null;
  precipProbPct: number | null;
  windKmh: number | null;
  windDeg: number | null;
  gustKmh: number | null;
  visibilityM: number | null;
  weatherCode: number | null;
  fogLikely: boolean;
  aod: number | null;
}

export interface WeatherForecast {
  lat: number;
  lng: number;
  fetchedAt: string;
  hourly: WeatherHour[];
}

const HOURLY_VARS = [
  'temperature_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation',
  'precipitation_probability', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'visibility', 'weather_code',
] as const;

type Hourly = Partial<Record<(typeof HOURLY_VARS)[number], (number | null)[]>> & { time?: (string | number)[] };

export type AirQualityHourly = {
  time?: (string | number)[];
  aerosol_optical_depth?: (number | null)[];
};

/** Parse an Open-Meteo Air Quality response into a Map from ISO UTC string to AOD. */
export function parseAirQuality(data: { hourly?: AirQualityHourly }): Map<string, number> {
  const map = new Map<string, number>();
  const times = data.hourly?.time ?? [];
  const aods = data.hourly?.aerosol_optical_depth ?? [];
  times.forEach((t, i) => {
    const d = typeof t === 'number' ? new Date(t * 1000) : new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
    if (Number.isNaN(d.getTime())) return;
    const v = num(aods[i]);
    if (v != null) map.set(d.toISOString(), v);
  });
  return map;
}

/** Fog: WMO codes 45/48, or visibility under 1 km, or near-saturated low cloud with calm wind is not enough on its own. */
export function isFogLikely(h: { visibilityM: number | null; weatherCode: number | null }): boolean {
  if (h.weatherCode === 45 || h.weatherCode === 48) return true;
  return h.visibilityM != null && h.visibilityM < 1000;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse an Open-Meteo response requested with timeformat=unixtime (or ISO GMT strings). */
export function parseOpenMeteo(
  data: { hourly?: Hourly },
  lat: number,
  lng: number,
  fetchedAt = new Date(),
  aodByTime?: Map<string, number>,
): WeatherForecast {
  const h = data.hourly ?? {};
  const times = h.time ?? [];
  const at = (k: (typeof HOURLY_VARS)[number], i: number) => num(h[k]?.[i]);
  const hourly: WeatherHour[] = [];
  times.forEach((t, i) => {
    const d = typeof t === 'number' ? new Date(t * 1000) : new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
    if (Number.isNaN(d.getTime())) return;
    const visibilityM = at('visibility', i);
    const weatherCode = at('weather_code', i);
    const isoTime = d.toISOString();
    hourly.push({
      time: isoTime,
      tempC: at('temperature_2m', i),
      cloudPct: at('cloud_cover', i),
      cloudLowPct: at('cloud_cover_low', i),
      cloudMidPct: at('cloud_cover_mid', i),
      cloudHighPct: at('cloud_cover_high', i),
      precipMm: at('precipitation', i),
      precipProbPct: at('precipitation_probability', i),
      windKmh: at('wind_speed_10m', i),
      windDeg: at('wind_direction_10m', i),
      gustKmh: at('wind_gusts_10m', i),
      visibilityM,
      weatherCode,
      fogLikely: isFogLikely({ visibilityM, weatherCode }),
      aod: aodByTime?.get(isoTime) ?? null,
    });
  });
  return { lat, lng, fetchedAt: fetchedAt.toISOString(), hourly };
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 20 * 60_000;
const GRID_DEG = 0.05;
const cache = new Map<string, { at: number; data: WeatherForecast }>();
const inflight = new Map<string, Promise<WeatherForecast>>();
const snap = (v: number) => Math.round(v / GRID_DEG) * GRID_DEG;

export async function fetchWeather(baseUrl: string, lat: number, lng: number, days = 7): Promise<WeatherForecast> {
  const d = Math.min(16, Math.max(1, Math.round(days)));
  const sLat = Number(snap(lat).toFixed(2));
  const sLng = Number(snap(lng).toFixed(2));
  const key = `${sLat},${sLng},${d}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1/forecast?latitude=${sLat}&longitude=${sLng}&hourly=${HOURLY_VARS.join(',')}`
        + `&wind_speed_unit=kmh&timeformat=unixtime&timezone=GMT&forecast_days=${d}&past_days=1`;
      const aqDays = Math.min(7, d);
      const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${sLat}&longitude=${sLng}&hourly=aerosol_optical_depth`
        + `&timeformat=unixtime&timezone=GMT&forecast_days=${aqDays}&past_days=1`;

      const [res, aqRes] = await Promise.all([
        fetch(url, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: controller.signal }),
        fetch(aqUrl, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: controller.signal }).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
      const weatherJson = (await res.json()) as { hourly?: Hourly };

      let aodMap: Map<string, number> | undefined;
      if (aqRes && aqRes.ok) {
        try {
          const aqJson = (await aqRes.json()) as { hourly?: AirQualityHourly };
          aodMap = parseAirQuality(aqJson);
        } catch {
          // If air-quality parse fails, keep forecast and set aod null
        }
      }

      const data = parseOpenMeteo(weatherJson, sLat, sLng, new Date(), aodMap);
      cache.set(key, { at: Date.now(), data });
      return data;
    } catch (err) {
      if (hit) return hit.data; // stale beats nothing
      throw err;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export interface WindGridPoint { lat: number; lng: number; windKmh: number; windDeg: number }
export interface WindGridResponse {
  bounds: { south: number; west: number; north: number; east: number };
  cols: number;
  rows: number;
  time: string;
  grid: WindGridPoint[];
}

const windGridCache = new Map<string, { at: number; data: WindGridResponse }>();
const WIND_GRID_CACHE_TTL_MS = 15 * 60_000;

/** Fetch a small viewport grid of hourly wind vectors from Open-Meteo. */
export async function fetchWindGrid(
  baseUrl: string,
  bounds: { south: number; west: number; north: number; east: number },
  cols = 4,
  rows = 4,
  timeMs?: number,
): Promise<WindGridResponse> {
  const cCount = Math.min(5, Math.max(2, Math.round(cols)));
  const rCount = Math.min(5, Math.max(2, Math.round(rows)));
  const targetDate = timeMs == null ? new Date() : new Date(timeMs);
  if (Number.isNaN(targetDate.getTime())) throw new Error('Invalid wind-grid time');
  const targetHourIso = new Date(Math.floor(targetDate.getTime() / 3_600_000) * 3_600_000).toISOString();
  const cacheKey = `${bounds.south.toFixed(1)},${bounds.west.toFixed(1)},${bounds.north.toFixed(1)},${bounds.east.toFixed(1)},${cCount}x${rCount},${targetHourIso}`;
  const hit = windGridCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WIND_GRID_CACHE_TTL_MS) return hit.data;

  const lats: number[] = [];
  const lngs: number[] = [];
  for (let r = 0; r < rCount; r++) {
    const lat = bounds.south + (r / (rCount - 1)) * (bounds.north - bounds.south);
    for (let c = 0; c < cCount; c++) {
      const lng = bounds.west + (c / (cCount - 1)) * (bounds.east - bounds.west);
      lats.push(Number(lat.toFixed(3)));
      lngs.push(Number(lng.toFixed(3)));
    }
  }

  const url = `${baseUrl.replace(/\/$/, '')}/v1/forecast?latitude=${lats.join(',')}&longitude=${lngs.join(',')}`
    + '&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timeformat=unixtime&forecast_days=2';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    const rawData = await res.json() as unknown;
    const items = Array.isArray(rawData) ? rawData : [rawData];
    const targetSec = Math.floor(targetDate.getTime() / 1000);
    const grid = items.map((item: any, i: number) => {
      const times: number[] = item?.hourly?.time ?? [];
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let j = 0; j < times.length; j++) {
        const diff = Math.abs(times[j] - targetSec);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = j; }
      }
      return {
        lat: lats[i] ?? item?.latitude ?? 0,
        lng: lngs[i] ?? item?.longitude ?? 0,
        windKmh: Number(item?.hourly?.wind_speed_10m?.[bestIdx] ?? 0),
        windDeg: Number(item?.hourly?.wind_direction_10m?.[bestIdx] ?? 0),
      };
    });
    const response: WindGridResponse = { bounds, cols: cCount, rows: rCount, time: targetDate.toISOString(), grid };
    windGridCache.set(cacheKey, { at: Date.now(), data: response });
    return response;
  } finally {
    clearTimeout(timer);
  }
}
