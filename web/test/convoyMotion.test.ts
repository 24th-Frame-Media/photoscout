import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVOY_BLEND_MS, ConvoyMotion, MAX_CONVOY_PREDICTION_M, MAX_CONVOY_PREDICTION_MS } from '../src/convoy/motion.js';
import { destination, haversineKm } from '../src/map/geo.js';
import type { Member, Position } from '../src/convoy/types.js';

const start = 100_000;
const fix = (patch: Partial<Position> = {}): Position => ({ lat: -33, lng: 149, ts: start, speed: 10, heading: 90, ...patch });
const member = (position: Position, patch: Partial<Member> = {}): Member => ({ id: 'a', username: 'Alice', avatar: '', online: true, lastSeen: position.ts, position, ...patch });
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

test('members glide from the drawn position to a new fix and turn through north by the short path', () => {
  const motion = new ConvoyMotion();
  motion.update([member(fix({ speed: 0, heading: 350 }))], start);
  const [lng, lat] = destination(-33, 149, 90, 0.02);
  const incoming = fix({ lat, lng, speed: 0, heading: 10, ts: start + 1000 });
  motion.update([member(incoming)], start + 1000);
  assert.ok(metres(motion.pose('a', start + 1000)!, fix()) < 0.01, 'no jump on delivery');
  const half = motion.pose('a', start + 1000 + CONVOY_BLEND_MS / 2)!;
  assert.ok(metres(half, fix()) > 9 && metres(half, fix()) < 11);
  assert.ok(half.heading! < 1 || half.heading! > 359, '350 to 10 crosses north');
  assert.ok(metres(motion.pose('a', start + 1000 + CONVOY_BLEND_MS)!, incoming) < 0.01);
});

test('speed prediction is capped by time and distance and never keeps driving a missing member', () => {
  const motion = new ConvoyMotion();
  motion.update([member(fix({ speed: 60 }))], start);
  const capped = motion.pose('a', start + MAX_CONVOY_PREDICTION_MS)!;
  assert.ok(metres(fix(), capped) <= MAX_CONVOY_PREDICTION_M + 0.1);
  assert.ok(capped.predicted);
  assert.deepEqual(motion.pose('a', start + 60_000), capped, 'freeze during a long GPS gap');
  motion.update([], start + 60_001);
  assert.equal(motion.pose('a', start + 60_001), null, 'leaving removes the track');
});

test('stationary members, stale snapshots and unknown motion are not extrapolated', () => {
  for (const [position, now] of [[fix({ speed: 0 }), start], [fix({ speed: null, heading: null }), start], [fix(), start + 20_000], [fix({ ts: start + 60_000 }), start]] as [Position, number][]) {
    const motion = new ConvoyMotion();
    motion.update([member(position)], now);
    assert.ok(metres(position, motion.pose('a', now + 10_000)!) < 0.01);
  }
});

test('missing speed and heading can be inferred from consecutive plausible fixes; old packets and repaints do not rewind', () => {
  const motion = new ConvoyMotion();
  const first = fix({ speed: null, heading: null });
  motion.update([member(first)], start);
  const [lng, lat] = destination(-33, 149, 90, 0.01);
  const next = fix({ lat, lng, speed: null, heading: null, ts: start + 1000 });
  motion.update([member(next)], start + 1000);
  const predicted = motion.pose('a', start + 2000)!;
  assert.ok(metres(predicted, next) > 9 && metres(predicted, next) < 11);
  motion.update([member(next)], start + 2100);
  const uninterrupted = motion.pose('a', start + 2300)!;
  motion.update([member(first)], start + 2300);
  assert.deepEqual(motion.pose('a', start + 2300), uninterrupted);
  motion.update([member(next, { online: false })], start + 2400);
  assert.equal(motion.pose('a', start + 2400), null);
});

test('large corrections and a new fix after suspension snap, rather than drifting through a town', () => {
  const motion = new ConvoyMotion();
  motion.update([member(fix())], start);
  const next = fix({ lat: -34, ts: start + 1000 });
  motion.update([member(next)], start + 1000);
  assert.ok(metres(next, motion.pose('a', start + 1000)!) < 0.01);
  const resumed = fix({ lat: -34.0001, speed: 0, ts: start + 60_000 });
  motion.update([member(resumed)], start + 60_000);
  assert.ok(metres(resumed, motion.pose('a', start + 60_000)!) < 0.01);
});
