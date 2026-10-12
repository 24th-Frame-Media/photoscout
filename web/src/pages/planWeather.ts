/** Weather for Plan shoot: api.weather (Open-Meteo via GET /api/weather), with missing values filled so scoring stays numeric. */
import { compass } from '../map/spotGlance.js';
import { api, type WeatherHour as ApiWeatherHour, type MarineData, type MarineHour } from '../api.js';
import type { WeatherHour, WeatherResponse } from '../map/recommend.js';

export interface PlanWeatherHour extends WeatherHour {
  aod: number | null;
}

export interface PlanWeatherResponse extends Omit<WeatherResponse, 'hourly'> {
  hourly: PlanWeatherHour[];
}

const FILL: Omit<WeatherHour, 'time' | 'fogLikely'> = {
  tempC: 0, cloudPct: 0, cloudLowPct: 0, cloudMidPct: 0, cloudHighPct: 0, precipMm: 0, precipProbPct: 0, windKmh: 0, gustKmh: 0, visibilityM: 20_000, weatherCode: 0,
};

export function normaliseHour(h: ApiWeatherHour): PlanWeatherHour {
  const out = { time: h.time, fogLikely: !!h.fogLikely, aod: h.aod ?? null } as PlanWeatherHour;
  for (const k of Object.keys(FILL) as (keyof typeof FILL)[]) (out as any)[k] = h[k] ?? FILL[k];
  if (h.gustKmh == null) out.gustKmh = out.windKmh;
  return out;
}

export async function fetchWeather(lat: number, lng: number, days = 7): Promise<PlanWeatherResponse> {
  const w = await api.weather(lat, lng, days);
  return { ...w, hourly: w.hourly.map(normaliseHour) };
}

export async function fetchMarine(lat: number, lng: number): Promise<MarineData> {
  return api.marine(lat, lng);
}


/** Format tides and swell for a coastal spot on a specific day: e.g. "Low 06:42 (0.3 m) · High 12:58 (1.6 m) · Swell 1.8 m SE 11 s". */
export function formatMarineDay(
  marine: MarineData | null | undefined,
  day: Date,
  focusTime?: Date,
): string | null {
  if (!marine || !marine.coastal) return null;

  const tideParts: string[] = [];
  if (marine.tides) {
    for (const t of marine.tides) {
      const d = new Date(t.time);
      if (
        d.getFullYear() === day.getFullYear() &&
        d.getMonth() === day.getMonth() &&
        d.getDate() === day.getDate()
      ) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const label = t.type === 'high' ? 'High' : 'Low';
        tideParts.push(`${label} ${hh}:${mm} (${t.height.toFixed(1)} m)`);
      }
    }
  }

  let swellStr: string | null = null;
  if (marine.hourly && marine.hourly.length > 0) {
    const targetMs = (focusTime ?? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12)).getTime();
    let bestHour: MarineHour | null = null;
    let minDiff = Infinity;
    for (const h of marine.hourly) {
      const diff = Math.abs(new Date(h.time).getTime() - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        bestHour = h;
      }
    }

    if (bestHour && minDiff < 43_200_000) {
      const height = bestHour.swellWaveHeight ?? bestHour.waveHeight;
      const dir = bestHour.swellWaveDirection ?? bestHour.waveDirection;
      const period = bestHour.wavePeriod;

      const swellTokens: string[] = [];
      if (height != null) swellTokens.push(`${height.toFixed(1)} m`);
      if (dir != null) swellTokens.push(compass(dir));
      if (period != null) swellTokens.push(`${Math.round(period)} s`);

      if (swellTokens.length > 0) {
        swellStr = `Swell ${swellTokens.join(' ')}`;
      }
    }
  }

  const parts = [...tideParts, ...(swellStr ? [swellStr] : [])];
  return parts.length ? parts.join(' · ') : null;
}
