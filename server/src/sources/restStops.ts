import { haversine, mPerDegLon } from '../geo.js';
import { overpassQuery } from './overpass.js';

export interface RestStopCandidate {
  lat: number;
  lng: number;
  name: string;
  kind: 'McDonald\'s' | 'service station' | 'rest area';
  hasToilets: boolean;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const SEARCH_RADIUS_M = 5_000;
const MAX_SEARCH_ANCHORS = 50;
const MAX_LOOKAHEAD_M = 100_000;
const BEHIND_TOLERANCE_M = 1_000;

function routeMetrics(route: [number, number][]) {
  const cumulative = [0];
  for (let i = 1; i < route.length; i++) cumulative.push(cumulative[i - 1] + haversine(route[i - 1][1], route[i - 1][0], route[i][1], route[i][0]));
  return cumulative;
}

function nearestOnRoute(route: [number, number][], point: [number, number]) {
  const cumulative = routeMetrics(route);
  let best = { along: 0, distance: Infinity };
  for (let i = 1; i < route.length; i++) {
    const [aLng, aLat] = route[i - 1];
    const [bLng, bLat] = route[i];
    const scale = mPerDegLon((aLat + bLat + point[1]) / 3);
    const ax = aLng * scale, ay = aLat * 111_320;
    const bx = bLng * scale, by = bLat * 111_320;
    const px = point[0] * scale, py = point[1] * 111_320;
    const dx = bx - ax, dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distance < best.distance) best = { along: cumulative[i - 1] + t * (cumulative[i] - cumulative[i - 1]), distance };
  }
  return best;
}

/** Chooses a suitable stop ahead, close to the route. Explicitly tagged toilets win among similarly nearby stops. */
export function chooseRestStop(route: [number, number][], from: [number, number], candidates: RestStopCandidate[]): RestStopCandidate | null {
  if (route.length < 2) return null;
  const fromAlong = nearestOnRoute(route, from).along;
  let picked: { candidate: RestStopCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const at = nearestOnRoute(route, [candidate.lng, candidate.lat]);
    if (at.along + BEHIND_TOLERANCE_M < fromAlong || at.along - fromAlong > MAX_LOOKAHEAD_M || at.distance > SEARCH_RADIUS_M) continue;
    const priority = candidate.hasToilets && candidate.kind === 'service station' ? 0
      : candidate.kind === 'McDonald\'s' ? 1
        : candidate.kind === 'service station' ? 2 : 3;
    const score = Math.max(0, at.along - fromAlong) + priority * 2_000 + at.distance * 2;
    if (!picked || score < picked.score) picked = { candidate, score };
  }
  return picked?.candidate ?? null;
}

export function restSearchAnchors(route: [number, number][], from: [number, number]): [number, number][] {
  if (route.length < 2) return route;
  const cumulative = routeMetrics(route);
  const start = nearestOnRoute(route, from).along;
  const end = Math.min(cumulative.at(-1)!, start + MAX_LOOKAHEAD_M);
  const count = Math.min(MAX_SEARCH_ANCHORS, Math.max(2, Math.ceil((end - start) / SEARCH_RADIUS_M) + 1));
  return Array.from({ length: count }, (_, i) => {
    const along = start + (end - start) * i / (count - 1);
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < along) segment++;
    const a = route[segment - 1], b = route[segment];
    const length = cumulative[segment] - cumulative[segment - 1];
    const t = length ? (along - cumulative[segment - 1]) / length : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}

function queryFor(route: [number, number][]): string {
  const clauses = route.flatMap(([lng, lat]) => [
    `nwr["amenity"="fuel"](around:${SEARCH_RADIUS_M},${lat},${lng});`,
    `nwr["highway"~"^(services|rest_area)$"](around:${SEARCH_RADIUS_M},${lat},${lng});`,
    `nwr["amenity"="fast_food"]["brand"~"McDonald's",i](around:${SEARCH_RADIUS_M},${lat},${lng});`,
    `nwr["amenity"="fast_food"]["name"~"McDonald",i](around:${SEARCH_RADIUS_M},${lat},${lng});`,
  ]).join('\n');
  return `[out:json][timeout:25];(\n${clauses}\n);out center tags;`;
}

function mapElement(element: OverpassElement): RestStopCandidate | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  const tags = element.tags ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const text = `${tags.name ?? ''} ${tags.brand ?? ''}`.toLowerCase();
  const kind: RestStopCandidate['kind'] = text.includes('mcdonald') ? 'McDonald\'s'
    : tags.amenity === 'fuel' || tags.highway === 'services' ? 'service station' : 'rest area';
  const toilets = /^(yes|customers|public)$/i.test(tags.toilets ?? '') || /^(yes|customers|public)$/i.test(tags['toilets:access'] ?? '');
  return { lat: lat!, lng: lng!, name: (tags.name ?? tags.brand ?? '').trim(), kind, hasToilets: toilets };
}

/** Finds an OSM-mapped rest stop near the remaining shared route. Results are advisory: facilities/tags can be incomplete. */
export async function findRestStop(route: [number, number][], from: [number, number]): Promise<RestStopCandidate | null> {
  if (route.length < 2) return null;
  const { elements } = await overpassQuery<{ elements: OverpassElement[] }>(queryFor(restSearchAnchors(route, from)), { timeoutMs: 8_000, deadlineMs: 15_000 });
  const deduped = new Map<string, RestStopCandidate>();
  for (const element of elements) {
    const candidate = mapElement(element);
    if (candidate) deduped.set(`${candidate.lat.toFixed(5)},${candidate.lng.toFixed(5)}`, candidate);
  }
  return chooseRestStop(route, from, [...deduped.values()]);
}

export function restStopLabel(stop: RestStopCandidate): string {
  const base = stop.name || stop.kind;
  return stop.hasToilets ? `${base} — toilets tagged` : base;
}
