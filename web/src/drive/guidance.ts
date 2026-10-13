/**
 * Turn-by-turn guidance as plain functions: where the car is on the route,
 * which turn is next, when to speak, when it has left the road and when it has
 * arrived. `advance` strings them together for one GPS fix; the Drive screen
 * only has to act on what it returns.
 */
import { distanceM, snapToPolyline, type LngLat, type Snap } from './geometry.js';
import { spokenDistance } from './format.js';
import type { NavRoute } from './route.js';

export interface Progress {
  /** Metres driven along the route (the nearest point on it). */
  alongM: number;
  /** Metres from the car to the route. */
  offRouteM: number;
  /** The step being driven: the last whose manoeuvre is behind the car. */
  stepIndex: number;
  /** The step whose manoeuvre is coming up, or -1 on the last stretch. */
  nextIndex: number;
  /** Metres to that manoeuvre. */
  toNextM: number;
  remainingM: number;
  remainingS: number;
}

/** Which step the car is on at `alongM`. */
export function stepAt(route: NavRoute, alongM: number): number {
  let lo = 0, hi = route.steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (route.steps[mid].startM <= alongM) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function progressOn(route: NavRoute, snap: Snap): Progress {
  const alongM = Math.max(0, Math.min(route.distanceM, snap.along));
  const stepIndex = stepAt(route, alongM);
  const step = route.steps[stepIndex];
  const nextIndex = stepIndex + 1 < route.steps.length ? stepIndex + 1 : -1;
  const into = step.distanceM > 0 ? Math.max(0, Math.min(1, (alongM - step.startM) / step.distanceM)) : 1;
  const later = route.steps.slice(stepIndex + 1).reduce((a, s) => a + s.durationS, 0);
  return {
    alongM,
    offRouteM: snap.distM,
    stepIndex,
    nextIndex,
    toNextM: nextIndex < 0 ? 0 : Math.max(0, route.steps[nextIndex].startM - alongM),
    remainingM: Math.max(0, route.distanceM - alongM),
    remainingS: step.durationS * (1 - into) + later,
  };
}

// --- when to speak ------------------------------------------------------------

/** 0 none yet; 1 the early warning; 2 the close one; 3 at the turn. */
export type PromptLevel = 0 | 1 | 2 | 3;

/**
 * How far from a turn each prompt is spoken. Scaled by speed so it is about
 * the same number of seconds ahead on a motorway as in a street: roughly
 * 500 m, 150 m and 40 m at 50 km/h.
 */
export function promptDistances(speedMps: number): { far: number; near: number; now: number } {
  const v = Math.max(0, speedMps);
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  return { far: clamp(v * 36, 250, 1200), near: clamp(v * 11, 80, 350), now: clamp(v * 3, 25, 80) };
}

/**
 * The prompt to speak now, if one is due: the closest one that has been
 * reached and not yet spoken. `legM` is the length of the road before the turn;
 * on a short leg the early warning is skipped, since it would only repeat the
 * last turn's instruction.
 */
export function duePrompt(toTurnM: number, speedMps: number, spoken: PromptLevel, legM: number): PromptLevel {
  const d = promptDistances(speedMps);
  if (toTurnM <= d.now && spoken < 3) return 3;
  if (toTurnM <= d.near && spoken < 2) return 2;
  if (toTurnM <= d.far && spoken < 1 && legM > d.far + 100) return 1;
  return 0;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** What is said: "In 500 metres, turn left onto Pacific Highway", then "Turn left onto Pacific Highway". */
export function promptText(level: PromptLevel, instruction: string, isArrival: boolean, toTurnM: number): string {
  if (isArrival) return level === 3 ? 'You have arrived at your destination' : `Your destination is in ${spokenDistance(toTurnM)}`;
  return level === 3 ? instruction : `In ${spokenDistance(toTurnM)}, ${lowerFirst(instruction)}`;
}

// --- off route -----------------------------------------------------------------

export interface OffRouteState {
  /** Fixes in a row that have been off the route. */
  strikes: number;
  /** When the first of them was. */
  since: number;
  lastRerouteAt: number;
}
export const initialOffRoute = (): OffRouteState => ({ strikes: 0, since: 0, lastRerouteAt: -Infinity });

export const OFF_ROUTE_M = 50;
const OFF_ROUTE_FIXES = 3;
const OFF_ROUTE_MIN_MS = 3_000;
const REROUTE_GAP_MS = 15_000;
/** A fix this vague cannot say whether the car is on the road. */
const USELESS_ACCURACY_M = 100;

/**
 * Count fixes in a row that are off the route. Off means further than 50 m, or
 * than the fix's own error if that is larger. A reroute is called for after
 * several such fixes spread over a few seconds, and not again for 15 s.
 */
export function offRouteTick(
  state: OffRouteState,
  fix: { offRouteM: number; accuracyM: number; now: number },
): { state: OffRouteState; reroute: boolean } {
  if (fix.accuracyM > USELESS_ACCURACY_M) return { state, reroute: false };
  if (fix.offRouteM <= Math.max(OFF_ROUTE_M, fix.accuracyM)) return { state: { ...state, strikes: 0 }, reroute: false };
  const strikes = state.strikes + 1;
  const since = state.strikes === 0 ? fix.now : state.since;
  if (strikes >= OFF_ROUTE_FIXES && fix.now - since >= OFF_ROUTE_MIN_MS && fix.now - state.lastRerouteAt >= REROUTE_GAP_MS) {
    return { state: { strikes: 0, since: 0, lastRerouteAt: fix.now }, reroute: true };
  }
  return { state: { strikes, since, lastRerouteAt: state.lastRerouteAt }, reroute: false };
}

// --- arrival ---------------------------------------------------------------------

/**
 * Whether the car has reached the end of the route: close to the last point
 * and on the last stretch of it. (Close alone is not enough: a loop ends where
 * it began.)
 */
export function hasArrived(route: NavRoute, remainingM: number, pos: LngLat, accuracyM: number): boolean {
  const end = route.coords[route.coords.length - 1];
  return remainingM <= 100 && distanceM(pos, end) <= Math.max(40, Math.min(accuracyM, 80));
}

// --- one fix at a time ---------------------------------------------------------------

export interface DriveSession {
  /** Last position along the route; keeps the nearest-point search to the stretch the car is on. */
  along: number;
  stepIndex: number;
  spoken: PromptLevel;
  started: boolean;
  arrived: boolean;
  offRoute: OffRouteState;
}
export const newSession = (): DriveSession => ({ along: 0, stepIndex: 0, spoken: 0, started: false, arrived: false, offRoute: initialOffRoute() });

export interface DriveUpdate {
  session: DriveSession;
  progress: Progress;
  /** Something to say aloud now. */
  say: string | null;
  reroute: boolean;
  arrived: boolean;
}

/** Take one GPS fix on a route: where the car is now, and what that calls for. */
export function advance(
  route: NavRoute,
  session: DriveSession,
  fix: { pos: LngLat; accuracyM: number; speedMps: number },
  now: number,
): DriveUpdate {
  const snap = snapToPolyline(route.coords, route.cum, fix.pos, { fromAlong: session.along });
  const progress = progressOn(route, snap);
  if (session.arrived) return { session, progress, say: null, reroute: false, arrived: true };

  if (hasArrived(route, progress.remainingM, fix.pos, fix.accuracyM)) {
    return { session: { ...session, along: progress.alongM, arrived: true }, progress, say: promptText(3, '', true, 0), reroute: false, arrived: true };
  }

  const off = offRouteTick(session.offRoute, { offRouteM: progress.offRouteM, accuracyM: fix.accuracyM, now });
  const stepChanged = progress.stepIndex !== session.stepIndex;
  let spoken: PromptLevel = stepChanged ? 0 : session.spoken;
  let say: string | null = null;

  if (!session.started) {
    say = route.steps[0].text;
  } else if (off.state.strikes === 0 && progress.nextIndex >= 0) {
    // Only while the car is on the route: directions for a road it is not on are noise.
    const next = route.steps[progress.nextIndex];
    const level = duePrompt(progress.toNextM, fix.speedMps, spoken, route.steps[progress.stepIndex].distanceM);
    if (level) {
      // The arrival announces itself, in the branch above, when the car is there; no "at the turn" for it.
      if (!(level === 3 && next.maneuver.type === 'arrive')) say = promptText(level, next.text, next.maneuver.type === 'arrive', progress.toNextM);
      spoken = level;
    }
  }

  return {
    session: { along: progress.alongM, stepIndex: progress.stepIndex, spoken, started: true, arrived: false, offRoute: off.state },
    progress,
    say,
    reroute: off.reroute,
    arrived: false,
  };
}
