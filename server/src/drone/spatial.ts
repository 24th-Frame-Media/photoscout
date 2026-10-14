import { haversine, M_PER_DEG_LAT, mPerDegLon } from '../geo.js';
import type { OpenAipAirspace, OpenAipAirport } from '../providers/openaip.js';
import type { DroneFireHazard } from './fireHazards.js';
import type { Plane } from '../feeds/planes.js';

export const CONTROLLED_3NM_BUFFER_METRES = 5556; // 3 nautical miles = 5556 m

/**
 * Checks if a 2D point (0, 0) in projected metres is inside a polygon ring.
 * Uses ray-casting algorithm along the positive X axis.
 */
function isProjectedPointInRing(ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = yi > 0 !== yj > 0 && 0 < ((xj - xi) * -yi) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Calculates the shortest distance from (0, 0) to a line segment from A to B in projected metres.
 */
function distanceToProjectedSegment(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) {
    return Math.hypot(a[0], a[1]);
  }
  const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  return Math.hypot(projX, projY);
}

/**
 * Project [lng, lat] coordinate into metres relative to [centerLng, centerLat].
 */
function projectToMetres(
  coord: [number, number],
  centerLat: number,
  centerLng: number
): [number, number] {
  const [lng, lat] = coord;
  const x = (lng - centerLng) * mPerDegLon(centerLat);
  const y = (lat - centerLat) * M_PER_DEG_LAT;
  return [x, y];
}

/**
 * Checks whether the filled area of a GeoJSON polygon intersects a planning
 * circle. Holes are respected: a circle entirely inside a hole is not an
 * airspace intersection, but touching that hole's boundary is.
 */
function polygonIntersectsCircle(
  rings: number[][][],
  centerLat: number,
  centerLng: number,
  radiusM: number
): boolean {
  const projectedRings = rings
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((pt) => projectToMetres([pt[0], pt[1]], centerLat, centerLng)));
  const outer = projectedRings[0];
  if (!outer) return false;

  const centerInFilledArea = isProjectedPointInRing(outer)
    && !projectedRings.slice(1).some((hole) => isProjectedPointInRing(hole));
  if (centerInFilledArea) return true;

  // Any circle that reaches an outer or inner boundary intersects the filled
  // polygon area on at least one side of that boundary.
  for (const ring of projectedRings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (distanceToProjectedSegment(ring[j], ring[i]) <= radiusM) return true;
    }
  }
  return false;
}

/**
 * Determines whether a GeoJSON geometry intersects a circle of radiusM centered at (centerLat, centerLng).
 */
export function intersectsCircle(
  geometry: GeoJSON.Geometry | undefined | null,
  centerLat: number,
  centerLng: number,
  radiusM: number
): boolean {
  if (!geometry) return false;

  switch (geometry.type) {
    case 'Point': {
      const [lng, lat] = (geometry as GeoJSON.Point).coordinates;
      return haversine(centerLat, centerLng, lat, lng) <= radiusM;
    }
    case 'MultiPoint': {
      const coords = (geometry as GeoJSON.MultiPoint).coordinates;
      return coords.some(([lng, lat]) => haversine(centerLat, centerLng, lat, lng) <= radiusM);
    }
    case 'LineString': {
      const coords = (geometry as GeoJSON.LineString).coordinates;
      const projected = coords.map((pt) => projectToMetres([pt[0], pt[1]], centerLat, centerLng));
      for (let i = 0; i < projected.length - 1; i++) {
        if (distanceToProjectedSegment(projected[i], projected[i + 1]) <= radiusM) {
          return true;
        }
      }
      return false;
    }
    case 'MultiLineString': {
      const lines = (geometry as GeoJSON.MultiLineString).coordinates;
      for (const line of lines) {
        const projected = line.map((pt) => projectToMetres([pt[0], pt[1]], centerLat, centerLng));
        for (let i = 0; i < projected.length - 1; i++) {
          if (distanceToProjectedSegment(projected[i], projected[i + 1]) <= radiusM) {
            return true;
          }
        }
      }
      return false;
    }
    case 'Polygon': {
      return polygonIntersectsCircle((geometry as GeoJSON.Polygon).coordinates, centerLat, centerLng, radiusM);
    }
    case 'MultiPolygon': {
      const polys = (geometry as GeoJSON.MultiPolygon).coordinates;
      return polys.some((rings) => polygonIntersectsCircle(rings, centerLat, centerLng, radiusM));
    }
    case 'GeometryCollection': {
      const geoms = (geometry as GeoJSON.GeometryCollection).geometries;
      return geoms.some((g) => intersectsCircle(g, centerLat, centerLng, radiusM));
    }
    default:
      return false;
  }
}

/**
 * Filter airspaces to only those intersecting the planned circle radius.
 */
export function filterAirspacesByRadius(
  airspaces: OpenAipAirspace[],
  centerLat: number,
  centerLng: number,
  radiusM: number
): OpenAipAirspace[] {
  return airspaces.filter((as) => intersectsCircle(as.geometry, centerLat, centerLng, radiusM));
}

/**
 * Filter modelled fire hazards to only those whose buffer geometry intersects the planned circle radius.
 */
export function filterFireHazardsByRadius(
  hazards: DroneFireHazard[],
  centerLat: number,
  centerLng: number,
  radiusM: number
): DroneFireHazard[] {
  return hazards.filter((h) => intersectsCircle(h.bufferGeometry, centerLat, centerLng, radiusM));
}

export type PlannedAirport = OpenAipAirport & {
  distanceM: number;
  outsidePlannedRadius?: boolean;
  controlledBuffer?: GeoJSON.Polygon;
};

/**
 * Selects aerodromes for planning:
 * 1. Controlled airports whose 3 NM buffers intersect the planned radius (distance <= radiusM + 5556 m).
 * 2. Uncontrolled airports that fall within the planned radius (distance <= radiusM).
 * 3. If no airport intersects, always includes the single closest mapped airport labeled as outsidePlannedRadius: true.
 */
export function selectAirportsForPlanning(
  airports: OpenAipAirport[],
  centerLat: number,
  centerLng: number,
  radiusM: number
): {
  airports: PlannedAirport[];
  closestAirport: PlannedAirport | null;
} {
  if (!airports.length) {
    return { airports: [], closestAirport: null };
  }

  const withDist: PlannedAirport[] = airports
    .filter((a) => a.geometry && Array.isArray(a.geometry.coordinates))
    .map((a) => {
      const [lng, lat] = a.geometry.coordinates;
      const distanceM = Math.round(haversine(centerLat, centerLng, lat, lng));
      return {
        ...a,
        distanceM,
      };
    });

  if (!withDist.length) {
    return { airports: [], closestAirport: null };
  }

  // Sort by distance to find the closest
  withDist.sort((a, b) => a.distanceM - b.distanceM);
  const closest = withDist[0];

  // An airport intersects if:
  // - controlled === true: distance <= radiusM + 5556 (3 NM buffer intersects)
  // - controlled !== true: distance <= radiusM
  const inRadius = withDist.filter((a) => {
    if (a.controlled === true) {
      return a.distanceM <= radiusM + CONTROLLED_3NM_BUFFER_METRES;
    }
    return a.distanceM <= radiusM;
  });

  if (inRadius.length > 0) {
    const mapped = inRadius.map((a) => ({ ...a, outsidePlannedRadius: false }));
    const closestInRadius = mapped.find((a) => a.id === closest.id) ?? { ...closest, outsidePlannedRadius: closest.distanceM > radiusM };
    return {
      airports: mapped,
      closestAirport: closestInRadius,
    };
  }

  // No airport intersects planned flight radius: include closest mapped airport labeled outsidePlannedRadius
  const closestOutside: PlannedAirport = {
    ...closest,
    outsidePlannedRadius: true,
  };

  return {
    airports: [closestOutside],
    closestAirport: closestOutside,
  };
}

export type PlannedAircraft = Plane & {
  distanceM: number;
};

/**
 * Sorts ADS-B aircraft by distance to planning pin and identifies the closest aircraft.
 */
export function findClosestAircraft(
  planes: Plane[],
  centerLat: number,
  centerLng: number
): {
  closest: PlannedAircraft | null;
  sorted: PlannedAircraft[];
} {
  const withDist: PlannedAircraft[] = planes.map((p) => ({
    ...p,
    distanceM: Math.round(haversine(centerLat, centerLng, p.lat, p.lon)),
  }));

  withDist.sort((a, b) => a.distanceM - b.distanceM);
  return {
    closest: withDist[0] ?? null,
    sorted: withDist,
  };
}
