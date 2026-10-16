/**
 * The Drive rules a source may tune (`DriveTuning` in api.ts): the host's own defaults and
 * the range each option accepts. Pure: no DOM, no maplibre, so the registry, the runner and
 * the banner all read the same numbers.
 */
import type { DriveTuning } from './api.js';

/** Every option, resolved: the host's own rule wherever a source set nothing. */
export type ResolvedDriveTuning = Required<DriveTuning>;

/** The host's rules. Core's behaviour before tuning existed; a source that sets nothing gets exactly these. */
export const DRIVE_TUNING_DEFAULTS: Readonly<ResolvedDriveTuning> = Object.freeze({
  nearbyM: 800,
  onRouteM: 100,
  aheadM: 1500,
  offRoadM: 45,
  speakMaxAgeMs: 10_000,
  speakMaxAccuracyM: 75,
});

/** The range each option accepts, inclusive. `addAlertSource` refuses a value outside it. */
export const DRIVE_TUNING_LIMITS: Readonly<Record<keyof ResolvedDriveTuning, { min: number; max: number }>> = {
  nearbyM: { min: 1, max: 10_000 },
  onRouteM: { min: 1, max: 1_000 },
  aheadM: { min: 1, max: 20_000 },
  offRoadM: { min: 1, max: 500 },
  speakMaxAgeMs: { min: 1_000, max: 60_000 },
  speakMaxAccuracyM: { min: 1, max: 500 },
};

/** The route-ahead window: what `routeAheadM` needs. */
export type RouteWindow = Pick<ResolvedDriveTuning, 'aheadM' | 'offRoadM' | 'onRouteM'>;
