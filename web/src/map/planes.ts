import type { PlaneInfo } from '../api.js';

/** Client copy of server/src/feeds/planes.ts's dead reckoning, recomputed locally as the time slider moves. */
const KNOTS_TO_KMH = 1.852;
const EARTH_KM = 6371;

export function deadReckon(plane: { lat: number; lon: number; track: number | null; gs: number | null }, minutes: number): { lat: number; lon: number } | null {
  if (plane.track == null || plane.gs == null) return null;
  const km = (plane.gs * KNOTS_TO_KMH * minutes) / 60;
  const d = km / EARTH_KM;
  const brg = (plane.track * Math.PI) / 180;
  const la1 = (plane.lat * Math.PI) / 180;
  const lo1 = (plane.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brg));
  const lo2 = lo1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (((lo2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** Format enriched aircraft info e.g. "Airbus A380-842 · Qantas · SYD → DFW · VH-OQA". */
export function formatPlaneDetails(info: PlaneInfo): string | null {
  const model = info.manufacturer && info.type
    ? (info.type.toLowerCase().startsWith(info.manufacturer.toLowerCase()) ? info.type : `${info.manufacturer} ${info.type}`)
    : (info.type || info.manufacturer || null);
  const operator = info.airline || info.owner || null;
  const route = info.origin && info.destination
    ? `${info.origin} → ${info.destination}`
    : (info.origin ? `From ${info.origin}` : info.destination ? `To ${info.destination}` : null);
  const reg = info.registration || null;
  const parts = [model, operator, route, reg].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : null;
}
