/** Open-Meteo Marine tides and swell. Cached per 0.05° cell for 1 h, stale-on-error. */

export interface MarineHour {
  time: string; // ISO UTC
  seaLevelHeightMsl: number | null;
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  swellWaveHeight: number | null;
  swellWaveDirection: number | null;
}

export interface TideExtreme {
  type: 'high' | 'low';
  time: string; // ISO UTC
  height: number; // meters
}

export interface MarineData {
  coastal: boolean;
  hourly?: MarineHour[];
  tides?: TideExtreme[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse an Open-Meteo marine response into an hourly series. Inland points return coastal: false. */
export function parseMarine(data: unknown): { coastal: boolean; hourly: MarineHour[] } {
  if (!data || typeof data !== 'object') return { coastal: false, hourly: [] };
  const h = (data as Record<string, unknown>).hourly as Record<string, unknown> | undefined;
  if (!h || typeof h !== 'object') return { coastal: false, hourly: [] };

  const times = Array.isArray(h.time) ? h.time : [];
  const seaLevels = Array.isArray(h.sea_level_height_msl) ? h.sea_level_height_msl : [];
  const waveHeights = Array.isArray(h.wave_height) ? h.wave_height : [];
  const waveDirs = Array.isArray(h.wave_direction) ? h.wave_direction : [];
  const wavePeriods = Array.isArray(h.wave_period) ? h.wave_period : [];
  const swellHeights = Array.isArray(h.swell_wave_height) ? h.swell_wave_height : [];
  const swellDirs = Array.isArray(h.swell_wave_direction) ? h.swell_wave_direction : [];

  const hasData = seaLevels.some((v) => typeof v === 'number' && Number.isFinite(v))
    || waveHeights.some((v) => typeof v === 'number' && Number.isFinite(v));
  if (!hasData) return { coastal: false, hourly: [] };

  const hourly: MarineHour[] = [];
  times.forEach((t, i) => {
    const d = typeof t === 'number' ? new Date(t * 1000) : new Date(/Z|[+-]\d\d:?\d\d$/.test(String(t)) ? String(t) : `${t}Z`);
    if (Number.isNaN(d.getTime())) return;
    hourly.push({
      time: d.toISOString(),
      seaLevelHeightMsl: num(seaLevels[i]),
      waveHeight: num(waveHeights[i]),
      waveDirection: num(waveDirs[i]),
      wavePeriod: num(wavePeriods[i]),
      swellWaveHeight: num(swellHeights[i]),
      swellWaveDirection: num(swellDirs[i]),
    });
  });

  return { coastal: true, hourly };
}

/** Local min/max of sea_level_height_msl with parabolic interpolation between hourly samples. */
export function tideExtremes(
  series: { time: string; seaLevelHeightMsl?: number | null; sea_level_height_msl?: number | null }[]
): TideExtreme[] {
  const extremes: TideExtreme[] = [];
  const val = (s?: { seaLevelHeightMsl?: number | null; sea_level_height_msl?: number | null }) =>
    s ? (s.seaLevelHeightMsl ?? s.sea_level_height_msl ?? null) : null;

  for (let i = 1; i < series.length - 1; i++) {
    const yPrev = val(series[i - 1]);
    const yCurr = val(series[i]);
    const yNext = val(series[i + 1]);

    if (yPrev == null || yCurr == null || yNext == null) continue;

    const isHigh = yCurr > yPrev && yCurr > yNext;
    const isLow = yCurr < yPrev && yCurr < yNext;

    if (!isHigh && !isLow) continue;

    // Parabolic interpolation: y(x) = a*x^2 + b*x + c with x in [-1, 1], sample i at x = 0
    const denom = 2 * (yPrev - 2 * yCurr + yNext);
    const xStar = denom !== 0 ? Math.max(-1, Math.min(1, (yPrev - yNext) / denom)) : 0;
    const yStar = denom !== 0 ? yCurr - Math.pow(yNext - yPrev, 2) / (4 * denom) : yCurr;

    const tPrev = new Date(series[i - 1].time).getTime();
    const tCurr = new Date(series[i].time).getTime();
    const tNext = new Date(series[i + 1].time).getTime();
    const dt = (tNext - tPrev) / 2 || (tCurr - tPrev) || 3_600_000;
    const tStar = tCurr + xStar * dt;

    const roundedTime = Math.round(tStar / 60_000) * 60_000;
    const roundedHeight = Math.round(yStar * 100) / 100;

    extremes.push({
      type: isHigh ? 'high' : 'low',
      time: new Date(roundedTime).toISOString(),
      height: roundedHeight,
    });
  }

  return extremes;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassDir(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60_000; // 1 h
const GRID_DEG = 0.05; // 0.05° cell
export const marineCache = new Map<string, { at: number; data: MarineData }>();
const inflight = new Map<string, Promise<MarineData>>();
const snap = (v: number) => Math.round(v / GRID_DEG) * GRID_DEG;

export async function fetchMarine(baseUrl: string, lat: number, lng: number): Promise<MarineData>;
export async function fetchMarine(lat: number, lng: number, baseUrl?: string): Promise<MarineData>;
export async function fetchMarine(
  arg1: string | number,
  arg2: number,
  arg3?: number | string,
): Promise<MarineData> {
  let baseUrl = process.env.OPEN_METEO_MARINE_URL ?? 'https://marine-api.open-meteo.com';
  let lat: number;
  let lng: number;

  if (typeof arg1 === 'string') {
    baseUrl = arg1;
    lat = arg2;
    lng = typeof arg3 === 'number' ? arg3 : 0;
  } else {
    lat = arg1;
    lng = arg2;
    if (typeof arg3 === 'string') baseUrl = arg3;
  }
  const sLat = Number(snap(lat).toFixed(2));
  const sLng = Number(snap(lng).toFixed(2));
  const key = `${sLat},${sLng}`;

  const hit = marineCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1/marine?latitude=${sLat}&longitude=${sLng}&hourly=sea_level_height_msl,wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction&timezone=UTC&forecast_days=7`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'photoscout/0.1' },
        signal: controller.signal,
      });

      if (!res.ok) {
        if (marineCache.has(key)) return marineCache.get(key)!.data;
        return { coastal: false };
      }

      const json = await res.json();
      const parsed = parseMarine(json);
      if (!parsed.coastal) {
        const data: MarineData = { coastal: false };
        marineCache.set(key, { at: Date.now(), data });
        return data;
      }

      const tides = tideExtremes(parsed.hourly);
      const data: MarineData = { coastal: true, hourly: parsed.hourly, tides };
      marineCache.set(key, { at: Date.now(), data });
      return data;
    } catch {
      if (marineCache.has(key)) return marineCache.get(key)!.data;
      return { coastal: false };
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}
