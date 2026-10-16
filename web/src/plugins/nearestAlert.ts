import type { DriveAlert, DriveAlertFilter, LngLat } from './api.js';
import { distanceM } from '../drive/geometry.js';
import { routeAheadM } from './routeAhead.js';

/** How close a 'nearby' alert must be to be shown (straight line). */
export const DRIVE_ALERT_RADIUS_M = 800;

export interface NearbyAlert {
  /** `<pluginId>:<key>` of the source that reported the alert. */
  sourceId: string;
  alert: DriveAlert;
  /** Metres: straight-line from the car, or along the route when `ahead`. */
  distanceM: number;
  /** True when `distanceM` is along the route ahead (a 'route-ahead' source). */
  ahead: boolean;
}

/** The closest alert within `maxM` of the car in a straight line, over the sources given. */
export function nearestAlert(bySource: Record<string, readonly DriveAlert[]>, position: LngLat | null, maxM = DRIVE_ALERT_RADIUS_M): NearbyAlert | null {
  if (!position) return null;
  let best: NearbyAlert | null = null;
  for (const [sourceId, alerts] of Object.entries(bySource)) {
    for (const alert of alerts) {
      const d = distanceM(position, alert.point);
      if (d <= maxM && (!best || d < best.distanceM)) best = { sourceId, alert, distanceM: d, ahead: false };
    }
  }
  return best;
}

/** The closest alert on the road ahead, by distance along `route`, over the sources given. */
export function nearestAheadAlert(bySource: Record<string, readonly DriveAlert[]>, route: LngLat[] | null, position: LngLat | null): NearbyAlert | null {
  if (!route || !position) return null;
  let best: NearbyAlert | null = null;
  for (const [sourceId, alerts] of Object.entries(bySource)) {
    for (const alert of alerts) {
      const d = routeAheadM(route, position, alert.point);
      if (d !== null && (!best || d < best.distanceM)) best = { sourceId, alert, distanceM: d, ahead: true };
    }
  }
  return best;
}

/**
 * The alert for the banner: each source's alerts go through its own filter ('nearby'
 * or 'route-ahead'), and the nearer of the two answers wins.
 */
export function bannerAlert(
  alerts: Record<string, readonly DriveAlert[]>,
  filterOf: (sourceId: string) => DriveAlertFilter,
  route: LngLat[] | null,
  position: LngLat | null,
): NearbyAlert | null {
  const nearby: Record<string, readonly DriveAlert[]> = {};
  const ahead: Record<string, readonly DriveAlert[]> = {};
  for (const [sourceId, list] of Object.entries(alerts)) {
    (filterOf(sourceId) === 'route-ahead' ? ahead : nearby)[sourceId] = list;
  }
  const near = nearestAlert(nearby, position);
  const onRoute = nearestAheadAlert(ahead, route, position);
  if (!near || !onRoute) return near ?? onRoute;
  return onRoute.distanceM < near.distanceM ? onRoute : near;
}
