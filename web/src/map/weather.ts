/** Weather overlay helpers: RainViewer radar frame choice and the map-centre readout. Pure, no MapLibre. */
import type { WeatherForecast, WeatherHour } from '../api.js';

export const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
export const RADAR_MAX_NATIVE_Z = 7;

export interface RadarIndex { host: string; radar: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } }
export interface RadarFrame { time: number; path: string; nowcast: boolean }

/** Frame to show at `t` (ms): the latest frame at or before t, if t lies within the frames' span (+10 min past the last). */
export function pickRadarFrame(idx: RadarIndex, t: number): RadarFrame | null {
  const frames: RadarFrame[] = [
    ...(idx.radar.past ?? []).map((f) => ({ ...f, nowcast: false })),
    ...(idx.radar.nowcast ?? []).map((f) => ({ ...f, nowcast: true })),
  ].sort((a, b) => a.time - b.time);
  if (!frames.length) return null;
  const s = t / 1000;
  if (s < frames[0].time - 300 || s > frames[frames.length - 1].time + 600) return null;
  let best = frames[0];
  for (const f of frames) if (f.time <= s) best = f;
  return best;
}

export const radarTileUrl = (host: string, frame: RadarFrame) => `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;

/** The forecast hour containing `t` (nearest within 90 min), else null. */
export function hourAt<T extends { time: string }>(f: { hourly: T[] } | null, t: number): T | null {
  if (!f) return null;
  let best: T | null = null;
  let bestD = Infinity;
  for (const h of f.hourly) {
    const d = Math.abs(Date.parse(h.time) + 30 * 60_000 - t);
    if (d < bestD) { bestD = d; best = h; }
  }
  return bestD <= 90 * 60_000 ? best : null;
}

/** Emoji for a WMO weather code (with fog override). */
export function weatherIcon(h: Pick<WeatherHour, 'weatherCode' | 'fogLikely' | 'cloudPct'>, night = false): string {
  const c = h.weatherCode;
  if (h.fogLikely) return '🌫';
  if (c == null) return (h.cloudPct ?? 0) > 70 ? '☁️' : night ? '🌙' : '☀️';
  if (c >= 95) return '⛈';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '🌨';
  if (c >= 51) return '🌧';
  if (c === 3) return '☁️';
  if (c === 2) return night ? '☁️' : '⛅';
  if (c === 1) return night ? '🌙' : '🌤';
  return night ? '🌙' : '☀️';
}

export type BurnLabel = 'Dull' | 'Fair' | 'Vibrant' | 'Fiery';

export interface BurnScoreResult {
  score: number;
  label: BurnLabel;
}

export interface BurnInput {
  cloudHighPct?: number | null;
  cloudMidPct?: number | null;
  cloudLowPct?: number | null;
  visibilityM?: number | null;
  aod?: number | null;
}

/** Predict sunset/sunrise colour score (0-100) and label based on clouds, horizon and atmospheric clarity. */
export function burnScore(
  at: BurnInput,
  horizonLowPct: number | null,
): BurnScoreResult {
  const high = at.cloudHighPct != null ? Math.max(0, Math.min(100, at.cloudHighPct)) : 0;
  const mid = at.cloudMidPct != null ? Math.max(0, Math.min(100, at.cloudMidPct)) : 0;
  const combined = Math.min(100, high + mid);

  // Canvas = high+mid cloud: trapezoid curve peaking around 30-70%, falling off toward 0% and 100%.
  let canvas = 0;
  if (combined >= 30 && combined <= 70) {
    canvas = 1;
  } else if (combined < 30) {
    canvas = combined / 30;
  } else {
    canvas = Math.max(0, (100 - combined) / 30);
  }

  // Curtain = low cloud at spot and horizon: heavy penalty above ~15%.
  const spotLow = at.cloudLowPct != null ? Math.max(0, Math.min(100, at.cloudLowPct)) : 0;
  const horizonLow = horizonLowPct != null ? Math.max(0, Math.min(100, horizonLowPct)) : spotLow;
  const curtainPenalty = (pct: number) => (pct <= 15 ? 1 : Math.max(0, 1 - (pct - 15) / 35));
  const curtain = curtainPenalty(spotLow) * curtainPenalty(horizonLow);

  // Clarity: visibility under 10 km or aod > 0.4 penalise; ignore when null.
  let clarity = 1;
  if (at.visibilityM != null && at.visibilityM < 10_000) {
    clarity *= Math.max(0, at.visibilityM / 10_000);
  }
  if (at.aod != null && at.aod > 0.4) {
    clarity *= Math.max(0, 1 - (at.aod - 0.4) / 0.6);
  }

  const rawScore = 100 * canvas * curtain * clarity;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  let label: BurnLabel = 'Dull';
  if (score > 75) {
    label = 'Fiery';
  } else if (score > 50) {
    label = 'Vibrant';
  } else if (score > 20) {
    label = 'Fair';
  } else {
    label = 'Dull';
  }

  return { score, label };
}
