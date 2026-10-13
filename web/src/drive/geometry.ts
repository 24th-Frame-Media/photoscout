/**
 * Where a position sits on a route line. Pure; no MapLibre, no DOM.
 *
 * A route is a polyline of [lng, lat]. Everything here works in metres, in a
 * flat frame centred on the point being asked about: over the few hundred
 * metres between a GPS fix and the road that is exact to a centimetre or two.
 */
import { haversineKm } from '../map/geo.js';

export type LngLat = [number, number];

const M_PER_DEG = 111_195; // a degree of latitude on the sphere haversine uses

/** Great-circle distance in metres. */
export const distanceM = (a: LngLat, b: LngLat): number => haversineKm(a[1], a[0], b[1], b[0]) * 1000;

/** Metres from the start of the line to each vertex; the last entry is the whole length. */
export function cumulativeM(line: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + distanceM(line[i - 1], line[i]));
  return out;
}

export interface Snap {
  /** Metres along the route to the nearest point on it. */
  along: number;
  /** Metres from the position to that point. */
  distM: number;
  /** Index of the segment the point is on (line[segment] to line[segment + 1]). */
  segment: number;
  point: LngLat;
}

/** Nearest point of one segment to `pos`: its fraction along the segment, and the distance to it in metres. */
function toSegment(a: LngLat, b: LngLat, pos: LngLat): { t: number; distM: number } {
  const kx = Math.cos((pos[1] * Math.PI) / 180) * M_PER_DEG;
  const ax = (a[0] - pos[0]) * kx, ay = (a[1] - pos[1]) * M_PER_DEG;
  const bx = (b[0] - pos[0]) * kx, by = (b[1] - pos[1]) * M_PER_DEG;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { t, distM: Math.hypot(ax + t * dx, ay + t * dy) };
}

export interface SnapOptions {
  /** Where the last fix was on the route. The stretch around it is tried first. */
  fromAlong?: number;
  /** How far back from `fromAlong` still counts as the same stretch of road. */
  backtrackM?: number;
  /** How far ahead of `fromAlong` is tried first. */
  aheadM?: number;
}

function nearest(line: LngLat[], cum: number[], pos: LngLat, lo: number, hi: number): Snap | null {
  let best: Snap | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    if (cum[i + 1] < lo || cum[i] > hi) continue;
    const { t, distM } = toSegment(line[i], line[i + 1], pos);
    if (best && distM >= best.distM) continue; // a tie keeps the earlier segment: the first pass of a road driven both ways
    best = {
      along: cum[i] + t * (cum[i + 1] - cum[i]),
      distM,
      segment: i,
      point: [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])],
    };
  }
  return best;
}

/**
 * The nearest point of the route to `pos`.
 *
 * Given where the last fix was, only the stretch around it is searched first,
 * so a route that comes back along the same road (an out-and-back, a circuit)
 * is not mistaken for its far end. If nothing in that stretch is close, the
 * whole route is searched, which is how a driver who rejoins further on is
 * found again.
 */
export function snapToPolyline(line: LngLat[], cum: number[], pos: LngLat, opts: SnapOptions = {}): Snap {
  if (line.length === 0) return { along: 0, distM: Infinity, segment: 0, point: pos };
  if (line.length === 1) return { along: 0, distM: distanceM(line[0], pos), segment: 0, point: line[0] };
  const total = cum[cum.length - 1];
  if (opts.fromAlong !== undefined) {
    const local = nearest(line, cum, pos, opts.fromAlong - (opts.backtrackM ?? 150), opts.fromAlong + (opts.aheadM ?? 2000));
    if (local && local.distM <= 100) return local;
    const whole = nearest(line, cum, pos, 0, total)!;
    return local && local.distM - whole.distM <= 30 ? local : whole;
  }
  return nearest(line, cum, pos, 0, total)!;
}

/** Shortest distance in metres from `pos` to the line. */
export const distanceToPolyline = (line: LngLat[], pos: LngLat): number => snapToPolyline(line, cumulativeM(line), pos).distM;
