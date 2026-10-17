/**
 * The road-ahead test behind `DriveSourceContext.routeAhead` and the banner's route-ahead
 * filter, applied to one point. Pure; no DOM, no maplibre.
 * The fixed cases in web/test/driveHost.test.ts pin its answers.
 */
import { cumulativeM, snapToPolyline, type LngLat } from '../drive/geometry.js';
import { DRIVE_TUNING_DEFAULTS, type RouteWindow } from './driveTuning.js';

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

/**
 * Metres along `route` from the car to `point`, if `point` is on the road ahead: null when the
 * route is unusable, the car is more than `onRouteM` from it, `point` is behind the car, further
 * than `aheadM` along, or further than `offRoadM` from the road. Unset window fields take the
 * host defaults (100 m, 1500 m, 45 m).
 */
export function routeAheadM(route: LngLat[], car: LngLat, point: LngLat, window: Partial<RouteWindow> = {}): number | null {
  if (route.length < 2) return null;
  const onRouteM = window.onRouteM ?? DRIVE_TUNING_DEFAULTS.onRouteM;
  const aheadM = window.aheadM ?? DRIVE_TUNING_DEFAULTS.aheadM;
  const offRoadM = window.offRoadM ?? DRIVE_TUNING_DEFAULTS.offRoadM;
  const cum = cumulative(route);
  const here = snapToPolyline(route, cum, car);
  if (here.distM > onRouteM) return null;
  const at = snapToPolyline(route, cum, point, {
    fromAlong: here.along,
    aheadM: Math.max(2000, aheadM + 500),
    backtrackM: BACKTRACK_M,
  });
  const along = at.along - here.along;
  if (at.distM > offRoadM || along < 0 || along > aheadM) return null;
  return along;
}
