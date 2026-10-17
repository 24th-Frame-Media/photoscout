import type { DriveAlert, DriveAlertFilter, LngLat } from './api.js';
import { distanceM } from '../drive/geometry.js';
import { DRIVE_TUNING_DEFAULTS, type ResolvedDriveTuning, type RouteWindow } from './driveTuning.js';
import { routeAheadM } from './routeAhead.js';

export interface NearbyAlert {
  /** `<pluginId>:<key>` of the source that reported the alert. */
  sourceId: string;
  alert: DriveAlert;
  /** Metres: straight-line from the car, or along the route when `ahead`. */
  distanceM: number;
  /** True when `distanceM` is along the route ahead (a 'route-ahead' source). */
  ahead: boolean;
}

/** The closest alert within `maxM` (default: the host's nearby radius) of the car in a straight line, over the sources given. */
export function nearestAlert(bySource: Record<string, readonly DriveAlert[]>, position: LngLat | null, maxM = DRIVE_TUNING_DEFAULTS.nearbyM): NearbyAlert | null {
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
export function nearestAheadAlert(bySource: Record<string, readonly DriveAlert[]>, route: LngLat[] | null, position: LngLat | null, window: Partial<RouteWindow> = {}): NearbyAlert | null {
  if (!route || !position) return null;
  let best: NearbyAlert | null = null;
  for (const [sourceId, alerts] of Object.entries(bySource)) {
    for (const alert of alerts) {
      const d = routeAheadM(route, position, alert.point, window);
      if (d !== null && (!best || d < best.distanceM)) best = { sourceId, alert, distanceM: d, ahead: true };
    }
  }
  return best;
}

/** What the banner needs to know about one source: its filter and its tuning. */
export interface BannerSource {
  filter: DriveAlertFilter;
  tuning: ResolvedDriveTuning;
}

/**
 * The alert for the banner. Each source's alerts are judged by its own filter ('nearby' or
 * 'route-ahead') and its own tuning; the nearer of the two kinds wins, and a tie goes to the
 * nearby one, as it always has.
 */
export function bannerAlert(
  alerts: Record<string, readonly DriveAlert[]>,
  sourceOf: (sourceId: string) => BannerSource,
  route: LngLat[] | null,
  position: LngLat | null,
): NearbyAlert | null {
  let near: NearbyAlert | null = null;
  let onRoute: NearbyAlert | null = null;
  for (const [sourceId, list] of Object.entries(alerts)) {
    const { filter, tuning } = sourceOf(sourceId);
    if (filter === 'route-ahead') {
      const found = nearestAheadAlert({ [sourceId]: list }, route, position, tuning);
      if (found && (!onRoute || found.distanceM < onRoute.distanceM)) onRoute = found;
    } else {
      const found = nearestAlert({ [sourceId]: list }, position, tuning.nearbyM);
      if (found && (!near || found.distanceM < near.distanceM)) near = found;
    }
  }
  if (!near || !onRoute) return near ?? onRoute;
  return onRoute.distanceM < near.distanceM ? onRoute : near;
}
