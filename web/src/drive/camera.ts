/**
 * What the car is doing, and where the camera should be because of it.
 * Pure: GPS fixes in, numbers out.
 */
import { angleDiff, bearing } from '../map/geo.js';
import { distanceM } from './geometry.js';

/** One position report, in plain numbers. */
export interface Fix {
  lng: number;
  lat: number;
  /** Metres: the radius the device is 68% sure it is within. */
  accuracy: number;
  /** Metres per second, when the device knows. */
  speed: number | null;
  /** Degrees clockwise from north, when the device knows (it does not at a standstill). */
  heading: number | null;
  /** Milliseconds since the epoch. */
  t: number;
}

/** Below this the heading a device reports is noise and a derived one is worse. */
export const MIN_HEADING_SPEED = 1.5;

export const kmh = (mps: number): number => Math.round(mps * 3.6);

/**
 * Speed and heading for a fix. Devices that report neither get them from the
 * move since the last fix; a heading is only trusted once the car is moving.
 */
export function motionOf(prev: Fix | null, cur: Fix): { speedMps: number; heading: number | null } {
  const dt = prev ? (cur.t - prev.t) / 1000 : 0;
  const moved = prev ? distanceM([prev.lng, prev.lat], [cur.lng, cur.lat]) : 0;
  // Two fixes closer than their own error say nothing about movement.
  const real = prev && dt > 0 && moved > Math.max(3, Math.min(prev.accuracy, cur.accuracy) / 2);
  const speedMps = cur.speed !== null && Number.isFinite(cur.speed) && cur.speed >= 0 ? cur.speed : real ? moved / dt : 0;
  let heading: number | null = null;
  if (speedMps >= MIN_HEADING_SPEED) {
    if (cur.heading !== null && Number.isFinite(cur.heading)) heading = cur.heading;
    else if (real) heading = bearing(prev.lat, prev.lng, cur.lat, cur.lng);
  }
  return { speedMps, heading };
}

/** How far to trust a fix: what to call it, for the readout. */
export type AccuracyLevel = 'good' | 'fair' | 'poor';
export const accuracyLevel = (accuracyM: number): AccuracyLevel => (accuracyM <= 15 ? 'good' : accuracyM <= 40 ? 'fair' : 'poor');

/** Zoom by speed: close in for a street at walking pace, out for a motorway. */
const ZOOM_BY_KMH: [number, number][] = [[0, 17.5], [20, 17.1], [50, 16.2], [80, 15.4], [110, 14.7]];
export function zoomForSpeed(speedKmh: number): number {
  const v = Math.max(0, speedKmh);
  for (let i = 1; i < ZOOM_BY_KMH.length; i++) {
    const [v1, z1] = ZOOM_BY_KMH[i];
    if (v <= v1) {
      const [v0, z0] = ZOOM_BY_KMH[i - 1];
      return z0 + ((z1 - z0) * (v - v0)) / (v1 - v0);
    }
  }
  return ZOOM_BY_KMH[ZOOM_BY_KMH.length - 1][1];
}

/** The heading-up camera's tilt. */
export const FOLLOW_PITCH = 60;

/**
 * Move a bearing toward a new one by `k` (0..1) the short way round, so the
 * map does not spin the long way across north. Returns 0..360.
 */
export function smoothBearing(from: number, to: number, k: number): number {
  return (from + angleDiff(to, from) * Math.max(0, Math.min(1, k)) + 360) % 360;
}
