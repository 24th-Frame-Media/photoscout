import { bearing, destination, haversineKm } from '../map/geo.js';
import type { Member, Position } from './types.js';

export const CONVOY_BLEND_MS = 600;
export const MAX_CONVOY_PREDICTION_MS = 3_000;
export const MAX_CONVOY_PREDICTION_M = 90;
const MAX_SPEED_MPS = 70;
const MAX_BLEND_M = 150;
const MAX_FIX_GAP_MS = 10_000;

export interface MemberPose { lat: number; lng: number; heading: number | null; predicted: boolean }
interface Track {
  fix: Position;
  receivedAt: number;
  speed: number;
  heading: number | null;
  from: MemberPose | null;
}

/** Local display estimates only: never sent back as GPS or used for regroup decisions. */
export class ConvoyMotion {
  private tracks = new Map<string, Track>();

  isAnimating(now: number): boolean {
    return [...this.tracks.values()].some((track) => (track.from && now - track.receivedAt < CONVOY_BLEND_MS)
      || (track.heading !== null && track.speed >= 1 && now - track.fix.ts < MAX_CONVOY_PREDICTION_MS && track.speed * Math.max(0, now - track.fix.ts) / 1000 < MAX_CONVOY_PREDICTION_M));
  }

  update(members: Member[], now: number): void {
    const alive = new Set<string>();
    for (const member of members) {
      const fix = member.position;
      if (!member.online || !fix) continue;
      alive.add(member.id);
      const previous = this.tracks.get(member.id);
      // Repaints, room metadata and old packets must not restart interpolation/prediction.
      if (previous && previous.fix.ts >= fix.ts) continue;
      const gap = previous ? fix.ts - previous.fix.ts : 0;
      const metres = previous ? haversineKm(previous.fix.lat, previous.fix.lng, fix.lat, fix.lng) * 1000 : 0;
      const inferred = previous && gap >= 500 && gap <= MAX_FIX_GAP_MS && metres >= 3 && metres / (gap / 1000) <= MAX_SPEED_MPS;
      const heading = fix.heading ?? (inferred ? bearing(previous!.fix.lat, previous!.fix.lng, fix.lat, fix.lng) : null);
      const speed = fix.speed ?? (inferred ? metres / (gap / 1000) : 0);
      const drawn = this.pose(member.id, now);
      const canBlend = drawn && gap <= MAX_FIX_GAP_MS && haversineKm(drawn.lat, drawn.lng, fix.lat, fix.lng) * 1000 <= MAX_BLEND_M;
      const fresh = Math.abs(now - fix.ts) <= MAX_CONVOY_PREDICTION_MS;
      this.tracks.set(member.id, { fix: { ...fix }, receivedAt: now, speed: fresh ? Math.max(0, Math.min(MAX_SPEED_MPS, speed)) : 0, heading, from: canBlend ? drawn : null });
    }
    for (const id of this.tracks.keys()) if (!alive.has(id)) this.tracks.delete(id);
  }

  pose(id: string, now: number): MemberPose | null {
    const track = this.tracks.get(id);
    if (!track) return null;
    const elapsed = Math.max(0, now - track.receivedAt);
    const age = Math.max(0, now - track.fix.ts);
    const predictionMs = Math.min(MAX_CONVOY_PREDICTION_MS, age);
    const distance = track.heading === null || track.speed < 1 ? 0 : Math.min(MAX_CONVOY_PREDICTION_M, track.speed * predictionMs / 1000);
    const [rawLng, lat] = destination(track.fix.lat, track.fix.lng, track.heading ?? 0, distance / 1000);
    const lng = ((rawLng + 540) % 360) - 180;
    const target: MemberPose = { lng, lat, heading: track.heading, predicted: distance > 1 };
    if (!track.from || elapsed >= CONVOY_BLEND_MS) return target;
    const t = elapsed / CONVOY_BLEND_MS;
    const blend = t * t * (3 - 2 * t);
    const from = track.from;
    const delta = from.heading !== null && target.heading !== null ? ((target.heading - from.heading + 540) % 360) - 180 : 0;
    return {
      lng: from.lng + ((((target.lng - from.lng) + 540) % 360) - 180) * blend,
      lat: from.lat + (target.lat - from.lat) * blend,
      heading: from.heading !== null && target.heading !== null ? (from.heading + delta * blend + 360) % 360 : target.heading,
      predicted: target.predicted,
    };
  }
}
