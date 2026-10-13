/**
 * A drivable route with its turn-by-turn steps: OSRM's answer, made into what
 * the Drive screen needs. The parsing, the wording and the arrow choice are
 * pure; only `fetchNavRoute` touches the network.
 */
import { MAX_ROUTE_STOPS, routeCoordsParam, thinStops } from '../map/routeGeometry.js';
import { cumulativeM, distanceM, snapToPolyline, type LngLat } from './geometry.js';

export interface Maneuver {
  type: string;
  modifier?: string;
  /** Roundabout exit number. */
  exit?: number;
  /** Compass bearing just after the manoeuvre, for "Head north". */
  bearingAfter?: number;
}

export interface NavStep {
  maneuver: Maneuver;
  /** Road name, or its number when it has no name. */
  name: string;
  /** What to say: "Turn left onto Pacific Highway". */
  text: string;
  /** Metres along the route where this step begins (where its manoeuvre happens). */
  startM: number;
  /** Length of the step: from its manoeuvre to the next one. */
  distanceM: number;
  durationS: number;
}

export interface NavRoute {
  coords: LngLat[];
  /** Metres to each vertex of `coords`. */
  cum: number[];
  distanceM: number;
  durationS: number;
  /** The first is the departure and the last the arrival (zero length). */
  steps: NavStep[];
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

/** "left", "slight right"... as a turn phrase. */
function turnPhrase(modifier: string | undefined): string {
  switch (modifier) {
    case 'left': case 'right': return `turn ${modifier}`;
    case 'slight left': case 'slight right': return `bear ${modifier.slice(7)}`;
    case 'sharp left': case 'sharp right': return `turn sharp ${modifier.slice(6)}`;
    case 'uturn': return 'make a U-turn';
    default: return 'continue straight';
  }
}

const side = (modifier: string | undefined): string => (modifier?.includes('left') ? 'left' : modifier?.includes('right') ? 'right' : '');
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The instruction for a step, in the voice of a passenger. */
export function describeManeuver(m: Maneuver, name: string): string {
  const onto = name ? ` onto ${name}` : '';
  const sd = side(m.modifier);
  switch (m.type) {
    case 'depart':
      return `Head ${m.bearingAfter === undefined ? 'off' : compass(m.bearingAfter)}${name ? ` on ${name}` : ''}`;
    case 'arrive':
      return `Arrive at your destination${sd ? `, on the ${sd}` : ''}`;
    case 'roundabout': case 'rotary': {
      const exit = m.exit && ORDINAL[m.exit] ? `take the ${ORDINAL[m.exit]} exit` : 'take the exit';
      return `At the roundabout, ${exit}${onto}`;
    }
    case 'roundabout turn':
      return `At the roundabout, ${turnPhrase(m.modifier)}${onto}`;
    case 'merge':
      return `Merge${sd ? ` ${sd}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${sd ? ` on the ${sd}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${sd ? ` on the ${sd}` : ''}${onto}`;
    case 'fork':
      return `Keep ${sd || 'straight'} at the fork${onto}`;
    case 'end of road':
      return `At the end of the road, ${turnPhrase(m.modifier)}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue': case 'turn': case 'exit roundabout': case 'exit rotary': default:
      // "Continue" with no turn to it is a road that changes name or stays the same.
      return m.modifier && m.modifier !== 'straight' ? `${capital(turnPhrase(m.modifier))}${onto}` : `Continue straight${onto}`;
  }
}

/** The arrow to draw for a manoeuvre: a shape, and degrees clockwise from straight ahead. */
export function arrowFor(m: Maneuver): { shape: 'arrow' | 'uturn' | 'roundabout' | 'arrive'; angle: number } {
  const angle = ({ 'sharp right': 135, right: 90, 'slight right': 45, straight: 0, 'slight left': -45, left: -90, 'sharp left': -135, uturn: 180 } as Record<string, number>)[m.modifier ?? 'straight'] ?? 0;
  if (m.type === 'arrive') return { shape: 'arrive', angle: 0 };
  if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'roundabout turn') return { shape: 'roundabout', angle };
  if (m.modifier === 'uturn') return { shape: 'uturn', angle: 0 };
  return { shape: 'arrow', angle };
}

interface OsrmStep {
  distance?: number; duration?: number; name?: string; ref?: string;
  maneuver?: { type?: string; modifier?: string; exit?: number; bearing_after?: number };
}
interface OsrmRoute {
  distance?: number; duration?: number;
  geometry?: { coordinates?: unknown };
  legs?: { steps?: OsrmStep[] }[];
}

/**
 * OSRM's response as a NavRoute, or null when it is not a usable route.
 *
 * Each leg between two stops ends in an "arrive" and the next begins with a
 * "depart". Those are the stops of a saved route, not places to stop, so they
 * are folded into the road they sit on: only the end of the whole route arrives.
 */
export function parseNavRoute(data: unknown): NavRoute | null {
  const body = data as { code?: string; routes?: OsrmRoute[] } | null;
  const route = body?.routes?.[0];
  const coords = route?.geometry?.coordinates;
  if (body?.code !== 'Ok' || !route || !Array.isArray(coords) || coords.length < 2) return null;
  if (!coords.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  const line = coords.map((p): LngLat => [p[0], p[1]]);
  const cum = cumulativeM(line);
  const length = cum[cum.length - 1];

  const legs = route.legs ?? [];
  const raw: { step: OsrmStep; leg: number }[] = legs.flatMap((l, leg) => (l.steps ?? []).map((step) => ({ step, leg })));
  const kept: NavStep[] = [];
  raw.forEach(({ step, leg }, i) => {
    const type = step.maneuver?.type ?? 'continue';
    const lastOfLeg = raw[i + 1]?.leg !== leg;
    const isLast = i === raw.length - 1;
    const distance = step.distance ?? 0, duration = step.duration ?? 0;
    const between = (type === 'arrive' && !isLast && lastOfLeg) || (type === 'depart' && leg > 0);
    if (between && kept.length) {
      // Its road continues the one before; its length goes with it.
      kept[kept.length - 1].distanceM += distance;
      kept[kept.length - 1].durationS += duration;
      return;
    }
    const maneuver: Maneuver = { type, modifier: step.maneuver?.modifier, exit: step.maneuver?.exit, bearingAfter: step.maneuver?.bearing_after };
    const name = (step.name || step.ref || '').trim();
    kept.push({ maneuver, name, text: describeManeuver(maneuver, name), startM: 0, distanceM: distance, durationS: duration });
  });
  if (kept.length === 0) return null;

  // The steps' own lengths add up to the line's, give or take rounding; make them agree exactly.
  const stepsTotal = kept.reduce((a, s) => a + s.distanceM, 0);
  const scale = stepsTotal > 0 ? length / stepsTotal : 1;
  let at = 0;
  for (const s of kept) { s.distanceM *= scale; s.startM = at; at += s.distanceM; }
  kept[kept.length - 1].startM = length; // arrival is at the very end

  return { coords: line, cum, distanceM: length, durationS: route.duration ?? kept.reduce((a, s) => a + s.durationS, 0), steps: kept };
}

/**
 * The stops still ahead of the driver: those that sit on the route beyond
 * where they are, so a reroute does not send them back for one they have passed.
 */
export function stopsAhead(route: NavRoute, stops: LngLat[], alongM: number): LngLat[] {
  return stops.filter((stop) => snapToPolyline(route.coords, route.cum, stop).along > alongM + 30);
}

/**
 * Stops for following a saved route from `here`: the driver first, so the
 * first leg gets them to the start, unless they are already at it. Thinned to
 * what the route API takes.
 */
export function stopsForSavedRoute(waypoints: LngLat[], here: LngLat | null): LngLat[] {
  const withHere = here && waypoints.length > 0 && distanceM(here, waypoints[0]) > 150 ? [here, ...waypoints] : waypoints;
  return thinStops(withHere, MAX_ROUTE_STOPS);
}

/** `to=lat,lng` from the address bar. */
export function parseTo(raw: string | null): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw ?? '');
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Ask the server for a drive through `stops`; throws a message fit to show a driver. */
export async function fetchNavRoute(stops: LngLat[], signal?: AbortSignal): Promise<NavRoute> {
  const res = await fetch(`/api/route?coords=${routeCoordsParam(thinStops(stops))}&steps=1`, { signal });
  if (res.status === 401) throw new Error('Sign in to get directions.');
  if (!res.ok) throw new Error(res.status === 502 ? 'The routing service is not answering. Try again in a moment.' : 'Could not get directions.');
  const data = await res.json() as { code?: string };
  const route = parseNavRoute(data);
  if (!route) throw new Error(data.code === 'NoRoute' || data.code === 'NoSegment' ? 'No driving route to there.' : 'Could not get directions.');
  return route;
}
