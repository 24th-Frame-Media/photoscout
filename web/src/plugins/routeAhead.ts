/**
 * The road-ahead test behind `DriveSourceContext.routeAhead`, applied to one point.
 * Pure; no DOM, no maplibre.
 * The fixed cases in web/test/driveHost.test.ts pin its answers.
 */
import { cumulativeM, snapToPolyline, type LngLat } from '../drive/geometry.js';
import type { RouteAheadOptions } from './api.js';

/** The car must be this close to the route for any answer. Fixed at 100 m. */
export const ON_ROUTE_M = 100;
const DEFAULT_AHEAD_M = 1500;
const DEFAULT_OFF_ROAD_M = 45;
/** How far behind the car's place on the route an alert is still snapped first. Fixed at 50 m. */
const BACKTRACK_M = 50;

const cumulativeCache = new WeakMap<LngLat[], number[]>();
function cumulative(route: LngLat[]): number[] {
  let c = cumulativeCache.get(route);
  if (!c) {
    c = cumulativeM(route);
    cumulativeCache.set(route, c);
  }
  return c;
}

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Metres along `route` from the car to `point`, if `point` is on the road ahead:
 * null when the route is unusable, the car is more than 100 m from it, `point` is
 * behind the car, further than `aheadM` along, or further than `offRoadM` from the road.
 */
export function routeAheadM(route: LngLat[], car: LngLat, point: LngLat, opts: RouteAheadOptions = {}): number | null {
  if (route.length < 2) return null;
  const aheadM = finiteOr(opts.aheadM, DEFAULT_AHEAD_M);
  const offRoadM = finiteOr(opts.offRoadM, DEFAULT_OFF_ROAD_M);
  const cum = cumulative(route);
  const here = snapToPolyline(route, cum, car);
  if (here.distM > ON_ROUTE_M) return null;
  const at = snapToPolyline(route, cum, point, {
    fromAlong: here.along,
    aheadM: Math.max(2000, aheadM + 500),
    backtrackM: BACKTRACK_M,
  });
  const along = at.along - here.along;
  if (at.distM > offRoadM || along < 0 || along > aheadM) return null;
  return along;
}
