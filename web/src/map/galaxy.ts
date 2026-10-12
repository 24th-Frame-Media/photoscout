/**
 * Milky Way galactic core position and dark-sky visibility windows.
 * Pure maths (suncalc for sun/moon).
 */
import { getMoonIllumination, getMoonPosition } from 'suncalc';
import { sunPos } from './sun.js';

export interface CelestialPosition {
  azimuth: number;
  altitude: number;
}

export interface MilkyWayWindow {
  start: Date;
  end: Date;
  label?: string;
}

const RAD = Math.PI / 180;
// Galactic center coordinates (J2000 epoch)
const RA_DEG = 266.417;
const DEC_DEG = -29.008;
const RA_RAD = RA_DEG * RAD;
const DEC_RAD = DEC_DEG * RAD;

/**
 * Galactic core position in compass degrees (azimuth 0=N, 90=E, 180=S, 270=W)
 * and true geometric altitude above the horizon.
 */
export function galacticCorePosition(date: Date, lat: number, lng: number): CelestialPosition {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { azimuth: 0, altitude: -90 };
  const d = date.getTime() / 86_400_000 - 10957.5; // days since J2000.0 (JD 2451545.0)
  const gmst = 280.46061837 + 360.98564736629 * d;
  const lst = gmst + lng;
  const H = lst * RAD - RA_RAD;
  const phi = lat * RAD;

  const sinAlt = Math.sin(phi) * Math.sin(DEC_RAD) + Math.cos(phi) * Math.cos(DEC_RAD) * Math.cos(H);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;

  const y = Math.sin(H);
  const x = Math.cos(H) * Math.sin(phi) - Math.tan(DEC_RAD) * Math.cos(phi);
  const az = ((Math.atan2(y, x) / RAD + 540) % 360 + 360) % 360;

  return { azimuth: az === 0 ? 0 : az, altitude };
}

/**
 * Contiguous windows across `day` (10-min resolution) where sun altitude < -18° (astronomical night),
 * galactic core altitude > 15°, and moon is below the horizon or illumination < 0.2.
 */
export function milkyWayWindows(day: Date, lat: number, lng: number, stepMin = 10): MilkyWayWindow[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const step = stepMin * 60_000;
  const out: MilkyWayWindow[] = [];

  for (let t = start; t < end; t += step) {
    const d = new Date(t);
    const sun = sunPos(d, lat, lng);
    if (sun.altitude >= -18) continue;

    const core = galacticCorePosition(d, lat, lng);
    if (core.altitude <= 15) continue;

    const moon = getMoonPosition(d, lat, lng);
    const moonIll = getMoonIllumination(d);
    if (moon.altitude > 0 && moonIll.fraction >= 0.2) continue;

    const last = out.at(-1);
    if (last && last.end.getTime() === t) {
      last.end = new Date(t + step);
    } else {
      out.push({ start: d, end: new Date(t + step), label: 'Milky Way core' });
    }
  }

  return out;
}
