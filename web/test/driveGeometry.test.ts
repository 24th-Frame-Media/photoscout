import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulativeM, distanceM, distanceToPolyline, snapToPolyline } from '../src/drive/geometry.js';
import { at } from './driveFixtures.js';

const near = (a: number, b: number, eps = 0.5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('cumulativeM: metres to each vertex, ending at the length', () => {
  const line = [at(0, 0), at(300, 0), at(300, 400)];
  const cum = cumulativeM(line);
  assert.equal(cum[0], 0);
  near(cum[1], 300);
  near(cum[2], 700);
});

test('snapToPolyline: along and distance for a point beside a straight road', () => {
  const line = [at(0, 0), at(1000, 0)];
  const cum = cumulativeM(line);
  const s = snapToPolyline(line, cum, at(400, 30));
  near(s.along, 400);
  near(s.distM, 30);
  assert.equal(s.segment, 0);
  near(distanceM(s.point, at(400, 0)), 0, 0.2);
});

test('snapToPolyline: clamps to the ends of the line', () => {
  const line = [at(0, 0), at(1000, 0)];
  const cum = cumulativeM(line);
  const before = snapToPolyline(line, cum, at(-50, 0));
  near(before.along, 0);
  near(before.distM, 50);
  const after = snapToPolyline(line, cum, at(1100, 0));
  near(after.along, 1000);
  near(after.distM, 100);
});

test('snapToPolyline: picks the right leg of a corner', () => {
  const line = [at(0, 0), at(1000, 0), at(1000, 1000)];
  const cum = cumulativeM(line);
  const s = snapToPolyline(line, cum, at(1020, 600));
  assert.equal(s.segment, 1);
  near(s.along, 1600);
  near(s.distM, 20);
});

test('snapToPolyline: degenerate lines do not throw', () => {
  assert.equal(snapToPolyline([], [], at(0, 0)).distM, Infinity);
  const one = snapToPolyline([at(0, 0)], [0], at(30, 0));
  near(one.distM, 30);
  const twice = [at(0, 0), at(0, 0), at(100, 0)];
  near(snapToPolyline(twice, cumulativeM(twice), at(50, 0)).along, 50);
});

test('snapToPolyline: an out-and-back is told apart by where the car last was', () => {
  // 1 km east, then straight back along the same road.
  const line = [at(0, 0), at(1000, 0), at(0, 1)];
  const cum = cumulativeM(line);
  const here = at(600, 0);
  near(snapToPolyline(line, cum, here).along, 600); // a tie goes to the first pass
  near(snapToPolyline(line, cum, here, { fromAlong: 1400 }).along, 1400); // on the way back
  near(snapToPolyline(line, cum, here, { fromAlong: 590 }).along, 600);
});

test('snapToPolyline: a driver who rejoins the route much further on is found again', () => {
  const line = [at(0, 0), at(5000, 0)];
  const cum = cumulativeM(line);
  const s = snapToPolyline(line, cum, at(4000, 10), { fromAlong: 500 });
  near(s.along, 4000);
});

test('snapToPolyline: far from the road, the stretch around the last fix still wins a near tie', () => {
  const line = [at(0, 0), at(1000, 0)];
  const cum = cumulativeM(line);
  const s = snapToPolyline(line, cum, at(300, 400), { fromAlong: 300 });
  near(s.along, 300);
  near(s.distM, 400);
});

test('distanceToPolyline: shortest distance, whichever segment', () => {
  const line = [at(0, 0), at(1000, 0), at(1000, 1000)];
  near(distanceToPolyline(line, at(500, 80)), 80);
  near(distanceToPolyline(line, at(900, 500)), 100);
  near(distanceToPolyline(line, at(0, 0)), 0);
});
