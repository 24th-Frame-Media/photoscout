import type { WazeAlert } from '../api.js';
import { cumulativeM, snapToPolyline, type LngLat } from './geometry.js';

export interface UpcomingReport { alert: WazeAlert; distanceM: number }
/** Reports on the road ahead, excluding nearby parallel roads and ones already passed. */
export function upcomingReports(alerts: WazeAlert[], route: LngLat[], position: LngLat, now = Date.now()): UpcomingReport[] {
  if (route.length < 2) return [];
  const cumulative = cumulativeM(route), here = snapToPolyline(route, cumulative, position);
  if (here.distM > 100) return [];
  return alerts.filter(a => ['POLICE', 'HAZARD', 'CONSTRUCTION', 'ACCIDENT', 'ROAD_CLOSED', 'CAMERA'].includes(a.type) &&
    (a.reportTime === null || (a.reportTime <= now + 60000 && now - a.reportTime < 2 * 3600_000)))
    .map(alert => { const at = snapToPolyline(route, cumulative, alert.point, { fromAlong: here.along, aheadM: 2000, backtrackM: 50 }); return { alert, distanceM: at.along - here.along, offRoadM: at.distM }; })
    .filter(a => a.offRoadM <= 45 && a.distanceM >= 0 && a.distanceM <= 1500)
    .sort((a, b) => a.distanceM - b.distanceM);
}
