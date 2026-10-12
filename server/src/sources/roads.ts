/**
 * OSM road quality: drivable/trackable ways from Overpass, graded from surface/smoothness tags.
 * Fetched per fixed 0.05 degree grid cell so cells cache (kv, 14 days) and overlap between viewports.
 */
import { Bbox } from '../geo.js';
import { overpassQuery } from './overpass.js';

export const CELL_DEG = 0.05;
export type Grade = 'good' | 'fair' | 'poor' | 'unknown';

interface RoadElement { type: 'way'; id: number; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }

const UNPAVED = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|compacted|sand|grass|mud|clay|pebblestone|rock|woodchips)$/;
const PAVED = /^(paved|asphalt|concrete|concrete:plates|concrete:lanes|paving_stones|sett|cobblestone|bricks|metal)$/;
const BAD = /^(bad|very_bad|horrible|very_horrible|impassable)$/;

/** Pure. Unpaved or bad smoothness -> poor; paved+excellent/good -> good; paved or intermediate -> fair.
 *  Untagged motorway/trunk/primary are assumed paved (fair); anything else untagged is unknown. */
export function gradeRoad(tags: Record<string, string>): Grade {
  const { surface = '', smoothness = '', highway = '' } = tags;
  if (UNPAVED.test(surface) || BAD.test(smoothness)) return 'poor';
  if (PAVED.test(surface) && /^(excellent|good)$/.test(smoothness)) return 'good';
  if (PAVED.test(surface) || smoothness === 'intermediate') return 'fair';
  if (/^(motorway|trunk|primary)(_link)?$/.test(highway)) return 'fair';
  return 'unknown';
}

/** Pure. "80" -> 80, "50 mph" -> 80 (km/h, rounded); anything else (e.g. "signals", "none") -> null. */
export function parseMaxspeed(raw: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$/i.exec(raw ?? '');
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1.609344 : 1));
}

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);

export function roadFeature(el: RoadElement) {
  const t = el.tags ?? {};
  if (!el.geometry || el.geometry.length < 2) return null;
  return {
    type: 'Feature' as const,
    id: el.id,
    geometry: { type: 'LineString' as const, coordinates: el.geometry.map((p) => [p.lon, p.lat]) },
    properties: {
      name: t.name ?? '', highway: t.highway ?? '', surface: t.surface ?? '', smoothness: t.smoothness ?? '',
      maxspeed: parseMaxspeed(t.maxspeed), lanes: num(t.lanes), grade: gradeRoad(t),
    },
  };
}
export type RoadFeature = NonNullable<ReturnType<typeof roadFeature>>;

/** Grid cells (south-west corners, snapped to CELL_DEG) covering a bbox. */
export function cellsFor(b: Bbox): Bbox[] {
  const cells: Bbox[] = [];
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  for (let s = Math.floor(b.south / CELL_DEG); s * CELL_DEG < b.north; s++)
    for (let w = Math.floor(b.west / CELL_DEG); w * CELL_DEG < b.east; w++)
      cells.push({ south: r(s * CELL_DEG), west: r(w * CELL_DEG), north: r((s + 1) * CELL_DEG), east: r((w + 1) * CELL_DEG) });
  return cells;
}

/** Pure. "south,west" -> cell if finite, in range and on the CELL_DEG grid; else null. */
export function parseCell(raw: string): Bbox | null {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return null;
  const [south, west] = [Number(m[1]), Number(m[2])];
  if (south < -90 || south > 90 - CELL_DEG || west < -180 || west > 180 - CELL_DEG) return null;
  const on = (n: number) => Math.abs(n / CELL_DEG - Math.round(n / CELL_DEG)) < 1e-6;
  if (!on(south) || !on(west)) return null;
  return cellsFor({ south: south + 1e-6, west: west + 1e-6, north: south + 1e-6, east: west + 1e-6 })[0];
}

export async function fetchRoadCell(c: Bbox): Promise<RoadFeature[]> {
  const q = `[out:json][timeout:60];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)(_link)?$"](${c.south},${c.west},${c.north},${c.east});out geom tags;`;
  const { elements } = await overpassQuery<{ elements: RoadElement[] }>(q, { timeoutMs: 12_000, deadlineMs: 20_000 });
  return elements.map(roadFeature).filter((f): f is RoadFeature => f !== null);
}
