import { parseNavRoute, type NavRoute } from '../src/drive/route.js';
import type { LngLat } from '../src/drive/geometry.js';

/** A point `east` and `north` metres from a fixed origin near Bathurst. */
export const O: LngLat = [149.58, -33.42];
export function at(east: number, north: number): LngLat {
  return [O[0] + east / (111_195 * Math.cos((O[1] * Math.PI) / 180)), O[1] + north / 111_195];
}

/** A point every 100 m along a path of corners. */
export function densify(corners: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [a, b] = [corners[i], corners[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 100));
    for (let k = 0; k < n; k++) out.push(at(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
  }
  out.push(at(...corners[corners.length - 1]));
  return out;
}

export const step = (type: string, modifier: string | undefined, name: string, distance: number, extra: Record<string, unknown> = {}) => ({
  distance, duration: distance / 14, name, maneuver: { type, modifier, bearing_after: 90, ...extra },
});

/** East 2 km on Main St, left onto High St for 1.5 km, arrive. */
export function osrmL() {
  return {
    code: 'Ok',
    routes: [{
      distance: 3500, duration: 250,
      geometry: { type: 'LineString', coordinates: densify([[0, 0], [2000, 0], [2000, 1500]]) },
      legs: [{ steps: [step('depart', undefined, 'Main St', 2000), step('turn', 'left', 'High St', 1500), step('arrive', undefined, 'High St', 0)] }],
    }],
  };
}
export const navL = (): NavRoute => parseNavRoute(osrmL())!;


/** The position `m` metres along a route (clamped to its ends). */
export function posAt(route: NavRoute, m: number): LngLat {
  const d = Math.max(0, Math.min(route.distanceM, m));
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < d) i++;
  const t = (d - route.cum[i - 1]) / (route.cum[i] - route.cum[i - 1]);
  const [a, b] = [route.coords[i - 1], route.coords[i]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
