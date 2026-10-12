/**
 * Route geometry helpers — pure functions for the Rolling Routes feature.
 *
 * A route is a sequence of [lng, lat] vertices.
 * - sprint: straight legs joining consecutive vertices.
 * - circuit: same, plus a closing leg from the last vertex back to the first.
 *
 * Provides domain-specific calculations for rolling automotive photography:
 * - Segment-by-segment bearings and distance telemetry.
 * - Sun vs car relative lighting classification (side rim light, backlight flare, front glare).
 * - Reversing stops.
 * - OSRM road snapping and telemetry extraction.
 */
import { angleDiff, bearing, haversineKm } from './geo.js';

export type RouteType = 'sprint' | 'circuit';

/**
 * Build the ordered list of directed segments for a route.
 *
 * Each segment is [from, to] as [lng, lat] pairs. The closing leg (last→first)
 * is appended last for circuits. Requires ≥ 2 vertices to produce any segments.
 */
export function buildRouteSegments(
  vertices: [number, number][],
  type: RouteType,
): [[number, number], [number, number]][] {
  if (vertices.length < 2) return [];
  const segs: [[number, number], [number, number]][] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    segs.push([vertices[i], vertices[i + 1]]);
  }
  if (type === 'circuit') {
    segs.push([vertices[vertices.length - 1], vertices[0]]);
  }
  return segs;
}

/**
 * Resolve the planning anchor for a route.
 *
 * The anchor is used as the location for sun/weather/trains/planes lookups in
 * Plan Shoot. Priority: staging location → first vertex → null.
 */
export function routePlanAnchor(
  vertices: [number, number][],
  staging: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (staging) return { lat: staging.lat, lng: staging.lng };
  if (vertices.length > 0) {
    const [lng, lat] = vertices[0];
    return { lat, lng };
  }
  return null;
}

/** Total distance along route vertices in kilometres. */
export function routeDistanceKm(vertices: [number, number][], type: RouteType = 'sprint'): number {
  const segs = buildRouteSegments(vertices, type);
  let total = 0;
  for (const [from, to] of segs) {
    total += haversineKm(from[1], from[0], to[1], to[0]);
  }
  return Math.round(total * 100) / 100;
}

/** Format seconds into human readable duration string (e.g. "3m 45s" or "1h 12m"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  seconds = Math.round(seconds);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h ${remMins}m`;
  }
  if (mins === 0) return `${secs}s`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/** Reverse route waypoints (flips direction of travel). */
export function reverseWaypoints(pts: [number, number][]): [number, number][] {
  return pts.slice().reverse();
}

/** The stops a user edits: saved waypoints, else the vertices of a small legacy route, else just its two ends. */
export function routeStops(d: { vertices: [number, number][]; waypoints?: [number, number][] }): [number, number][] {
  return d.waypoints ?? (d.vertices.length > 15 ? [d.vertices[0], d.vertices.at(-1)!] : d.vertices);
}

/** Marker and list label for a stop: A, 2, 3 ... B. */
export function stopLabel(index: number, total: number): string {
  return index === 0 ? 'A' : index === total - 1 ? 'B' : String(index + 1);
}

// --- Lighting -----------------------------------------------------------------

export type LightingCategory = 'side' | 'backlit' | 'front';

/** Sun relative to the car's heading: behind the car is backlit, ahead is front glare, else side light. */
export function classifyLighting(carBearingDeg: number, sunAzimuthDeg: number): LightingCategory {
  const angle = Math.abs(angleDiff(carBearingDeg, sunAzimuthDeg));
  return angle > 135 ? 'backlit' : angle >= 45 ? 'side' : 'front';
}

/** Share of the route (by distance, whole percents) in each lighting category. */
export function routeLightingMix(
  vertices: [number, number][],
  type: RouteType,
  sunAzimuthDeg: number,
): Record<LightingCategory, number> {
  const dist: Record<LightingCategory, number> = { side: 0, backlit: 0, front: 0 };
  let total = 0;
  for (const [from, to] of buildRouteSegments(vertices, type)) {
    const d = haversineKm(from[1], from[0], to[1], to[0]);
    dist[classifyLighting(bearing(from[1], from[0], to[1], to[0]), sunAzimuthDeg)] += d;
    total += d;
  }
  if (total <= 0) return { side: 0, backlit: 0, front: 0 };
  const side = Math.round((dist.side / total) * 100), backlit = Math.round((dist.backlit / total) * 100);
  return { side, backlit, front: Math.max(0, 100 - side - backlit) };
}

// --- OSRM API Helpers --------------------------------------------------------

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

export interface OsrmFullRouteResult {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
}

/** OSRM needs the closing stop explicitly so a loop follows roads back to Start. */
export function routingWaypoints(waypoints: [number, number][], type: RouteType): [number, number][] {
  if (type !== 'circuit' || waypoints.length < 2) return waypoints;
  const first = waypoints[0], last = waypoints[waypoints.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? waypoints : [...waypoints, first];
}

/** Fetch full OSRM road route connecting an array of waypoints, including total distance & duration. */
export async function fetchOsrmFullRoute(waypoints: [number, number][]): Promise<OsrmFullRouteResult | null> {
  if (waypoints.length < 2) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const locs = waypoints.map((pt) => `${pt[0]},${pt[1]}`).join(';');
    const r = await fetch(`${OSRM}/${locs}?geometries=geojson&overview=full`, { signal: controller.signal });
    if (!r.ok) return null;
    const data = await r.json() as {
      code?: string;
      routes?: {
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: [number, number][] };
      }[];
    };
    const route = data.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (data.code !== 'Ok' || !Array.isArray(coordinates) || coordinates.length < 2) return null;
    if (!coordinates.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return null;
    return {
      coordinates,
      distanceMeters: route?.distance ?? 0,
      durationSeconds: route?.duration ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
