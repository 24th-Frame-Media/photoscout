/**
 * Sun position -> MapLibre style lighting, for the "view from the spot" preview.
 * Pure (no DOM, no maplibre import): reuses sun.ts's altitude thresholds/colors.
 */
import { phaseFor, PHASE_COLOR, type Phase } from './sun.js';

function hex(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0');
}
function lerpColor(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const [r, g, bl] = pa.map((v, i) => v + (pb[i] - v) * t);
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

/** Smoothly-interpolated key colour for altitude `alt`, across night/blue/golden/day. */
function skyBase(alt: number): string {
  const night = PHASE_COLOR.night;
  const blue = PHASE_COLOR.blue;
  const golden = PHASE_COLOR.golden_am;
  const day = PHASE_COLOR.day;
  if (alt <= -6) return night;
  if (alt <= 0) return lerpColor(night, blue, (alt + 6) / 6);
  if (alt <= 6) return lerpColor(blue, golden, alt / 6);
  return lerpColor(golden, day, Math.min(1, (alt - 6) / 20));
}

export interface SunLook {
  sky: {
    'sky-color': string;
    'horizon-color': string;
    'fog-color': string;
    'sky-horizon-blend': number;
    'horizon-fog-blend': number;
    'fog-ground-blend': number;
    'atmosphere-blend': number;
  };
  light: { anchor: 'map'; position: [number, number, number]; color: string; intensity: number };
  hillshade: {
    'hillshade-illumination-direction': number;
    'hillshade-illumination-anchor': 'map';
    'hillshade-shadow-color': string;
    'hillshade-highlight-color': string;
    'hillshade-exaggeration': number;
  };
  phase: Phase;
}

/** Weather that dulls the sky: cloud cover %, rain mm/h, fog. Missing values count as clear. */
export interface SkyWeather { cloudPct?: number | null; precipMm?: number | null; fogLikely?: boolean | null }

/** How overcast the sky looks, 0 (clear) to 1 (heavy grey): cloud cover, darkened further by rain, fog fully grey. */
export function overcast(w: SkyWeather | null | undefined): number {
  if (!w) return 0;
  if (w.fogLikely) return 1;
  const cloud = Math.max(0, Math.min(1, ((w.cloudPct ?? 0) - 20) / 70)); // light cloud still reads as blue sky
  return Math.min(1, cloud * 0.85 + ((w.precipMm ?? 0) > 0.2 ? 0.25 : 0));
}

export function sunLook(sun: { altitude: number; azimuth: number }, weather?: SkyWeather | null): SunLook {
  const { altitude: alt, azimuth } = sun;
  const phase = phaseFor(alt, true);
  const base = skyBase(alt);
  const dayT = Math.max(0, Math.min(1, (alt + 6) / 12)); // 0 at night/blue, 1 by golden/day
  const intensity = Math.max(0.05, Math.min(1, (alt + 10) / 40));
  const polar = Math.max(0, Math.min(90, 90 - alt));
  const grey = overcast(weather);

  return {
    sky: {
      // Clear: deep blue overhead, the sun-phase tint at the horizon. Overcast pulls both to a grey that dims at night.
      'sky-color': lerpColor(lerpColor('#0a1a3a', '#3a8fd9', dayT), lerpColor('#1c1f24', '#8b9097', dayT), grey),
      'horizon-color': lerpColor(base, lerpColor('#24272c', '#b3b7bc', dayT), grey),
      'fog-color': lerpColor(base, lerpColor('#24272c', '#b3b7bc', dayT), grey),
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.5,
      'atmosphere-blend': Math.max(0.1, dayT),
    },
    light: { anchor: 'map', position: [1.5, azimuth, polar], color: base, intensity },
    hillshade: {
      'hillshade-illumination-direction': azimuth,
      'hillshade-illumination-anchor': 'map',
      'hillshade-shadow-color': lerpColor('#000000', '#1a1a2a', dayT),
      'hillshade-highlight-color': lerpColor('#333333', '#ffffff', dayT),
      'hillshade-exaggeration': 0.5,
    },
    phase,
  };
}
