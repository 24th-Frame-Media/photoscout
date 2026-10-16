import type { DriveAlert, LngLat } from './api.js';
import { distanceM } from '../drive/geometry.js';

/** How close an alert must be to be shown (straight line). */
export const DRIVE_ALERT_RADIUS_M = 800;

export interface NearbyAlert {
  pluginId: string;
  alert: DriveAlert;
  distanceM: number;
}

/**
 * The closest alert within `maxM` of the car, over every plugin's alerts.
 *
 * TODO(drive): this is straight-line, so it can name a hazard on a parallel
 * road or one already passed. The Waze feed filters to the route ahead
 * (drive/reports.ts `upcomingReports`); a plugin-agnostic version needs the
 * Drive screen's route in `DriveSourceContext` and a heading-aware filter.
 */
export function nearestAlert(bySource: Record<string, readonly DriveAlert[]>, position: LngLat | null, maxM = DRIVE_ALERT_RADIUS_M): NearbyAlert | null {
  if (!position) return null;
  let best: NearbyAlert | null = null;
  for (const [pluginId, alerts] of Object.entries(bySource)) {
    for (const alert of alerts) {
      const d = distanceM(position, alert.point);
      if (d <= maxM && (!best || d < best.distanceM)) best = { pluginId, alert, distanceM: d };
    }
  }
  return best;
}
