import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, duePrompt, hasArrived, initialOffRoute, newSession, offRouteTick, progressOn, promptDistances, promptText, stepAt,
  type DriveSession, type OffRouteState,
} from '../src/drive/guidance.js';
import { snapToPolyline } from '../src/drive/geometry.js';
import { at, navL, posAt } from './driveFixtures.js';

const near = (a: number, b: number, eps = 1) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const route = navL(); // east 2 km, left, north 1.5 km
const V = 50 / 3.6; // 50 km/h

test('stepAt and progressOn: the step being driven, the next turn and what is left', () => {
  assert.equal(stepAt(route, 0), 0);
  assert.equal(stepAt(route, 1999), 0);
  assert.equal(stepAt(route, 2000), 1);
  assert.equal(stepAt(route, 3500), 2);

  const p = progressOn(route, snapToPolyline(route.coords, route.cum, at(1500, 20)));
  assert.equal(p.stepIndex, 0);
  assert.equal(p.nextIndex, 1);
  near(p.alongM, 1500);
  near(p.toNextM, 500);
  near(p.offRouteM, 20);
  near(p.remainingM, 2000);
  // 500 m of the 2 km step is left, then the whole second step.
  near(p.remainingS, (2000 / 14) * 0.25 + 1500 / 14, 0.5);

  const last = progressOn(route, snapToPolyline(route.coords, route.cum, at(2000, 1450)));
  assert.equal(last.stepIndex, 1);
  assert.equal(last.nextIndex, 2);
  near(last.toNextM, 50);

  const end = progressOn(route, snapToPolyline(route.coords, route.cum, at(2000, 1500)));
  assert.equal(end.nextIndex, -1);
  assert.equal(end.toNextM, 0);
  near(end.remainingM, 0);
});

test('promptDistances: about 500 m, 150 m and 40 m at 50 km/h, further out when faster, never silly when slow', () => {
  const d = promptDistances(V);
  near(d.far, 500, 5);
  near(d.near, 153, 5);
  near(d.now, 42, 3);
  const fast = promptDistances(110 / 3.6);
  assert.ok(fast.far > d.far && fast.near > d.near && fast.now > d.now);
  assert.deepEqual(promptDistances(0), { far: 250, near: 80, now: 25 });
  assert.equal(promptDistances(100).far, 1200);
});

test('duePrompt: each level once, closest first, early warning only on a long enough leg', () => {
  assert.equal(duePrompt(800, V, 0, 3000), 0);
  assert.equal(duePrompt(480, V, 0, 3000), 1);
  assert.equal(duePrompt(480, V, 1, 3000), 0);
  assert.equal(duePrompt(140, V, 1, 3000), 2);
  assert.equal(duePrompt(140, V, 0, 3000), 2, 'a missed early warning is not spoken late');
  assert.equal(duePrompt(30, V, 2, 3000), 3);
  assert.equal(duePrompt(30, V, 3, 3000), 0);
  assert.equal(duePrompt(480, V, 0, 400), 0, 'a 400 m leg does not get a 500 m warning');
  assert.equal(duePrompt(140, V, 0, 400), 2);
});

test('promptText: distance, then the instruction; the arrival has its own words', () => {
  assert.equal(promptText(1, 'Turn left onto High St', false, 487), 'In 500 metres, turn left onto High St');
  assert.equal(promptText(2, 'Turn left onto High St', false, 148), 'In 150 metres, turn left onto High St');
  assert.equal(promptText(3, 'Turn left onto High St', false, 30), 'Turn left onto High St');
  assert.equal(promptText(1, '', true, 520), 'Your destination is in 500 metres');
  assert.equal(promptText(3, '', true, 0), 'You have arrived at your destination');
});

test('offRouteTick: several fixes in a row, over a few seconds, and then not again for a while', () => {
  let s: OffRouteState = initialOffRoute();
  const tick = (offRouteM: number, now: number, accuracyM = 8) => {
    const r = offRouteTick(s, { offRouteM, accuracyM, now });
    s = r.state;
    return r.reroute;
  };
  assert.equal(tick(80, 0), false);
  assert.equal(tick(80, 1000), false);
  assert.equal(tick(80, 2000), false, 'three fixes, but only two seconds');
  assert.equal(tick(80, 3000), true);
  assert.equal(tick(80, 4000), false);
  assert.equal(tick(80, 5000), false);
  assert.equal(tick(80, 6000), false);
  assert.equal(tick(80, 17_000), false, 'debounced: asked 14 s ago');
  assert.equal(tick(80, 18_500), true, 'asked again once it has been 15 s');
});

test('offRouteTick: a fix back on the road starts the count again, and a vague fix counts for nothing', () => {
  let s: OffRouteState = initialOffRoute();
  const tick = (offRouteM: number, now: number, accuracyM = 8) => {
    const r = offRouteTick(s, { offRouteM, accuracyM, now });
    s = r.state;
    return r.reroute;
  };
  tick(80, 0); tick(80, 1500);
  tick(10, 2000); // back on the road
  assert.equal(s.strikes, 0);
  assert.equal(tick(80, 3000), false);
  assert.equal(tick(80, 4500), false);
  assert.equal(tick(80, 6000), true);

  s = initialOffRoute();
  for (let t = 0; t < 20_000; t += 1000) assert.equal(tick(300, t, 150), false, 'a 150 m error says nothing');
  assert.equal(s.strikes, 0);
  // 60 m off with a 70 m error is not proof of anything.
  for (let t = 0; t < 20_000; t += 1000) assert.equal(tick(60, t, 70), false);
});

test('hasArrived: near the end and on the last stretch, not merely near the end of a loop', () => {
  const end = route.coords.at(-1)!;
  assert.equal(hasArrived(route, 10, end, 8), true);
  assert.equal(hasArrived(route, 40, at(2000, 1470), 8), true, '30 m short is outside a driveway, not outside the trip');
  assert.equal(hasArrived(route, 60, at(2000, 1440), 8), false, '60 m short is not there yet');
  assert.equal(hasArrived(route, 60, at(2000, 1440), 60), true, 'but may be, when the fix could be 60 m out');
  assert.equal(hasArrived(route, 3400, end, 8), false, 'at the end point but 3 km of route still to go (a loop)');
});

interface Drive { say: string[]; reroutes: number; arrivedAt: number | null; last: DriveSession }

/** Drive the route at a steady speed, a fix a second, and write down what the guidance does. */
function drive(opts: { speed?: number; from?: number; to?: number; offset?: (m: number) => [number, number]; accuracy?: number } = {}): Drive {
  const speed = opts.speed ?? V;
  let session = newSession();
  const out: Drive = { say: [], reroutes: 0, arrivedAt: null, last: session };
  let t = 0;
  for (let m = opts.from ?? 0; m <= (opts.to ?? route.distanceM) + speed; m += speed, t += 1000) {
    const base = posAt(route, m);
    const [de, dn] = opts.offset?.(m) ?? [0, 0];
    const pos: [number, number] = [base[0] + de / (111_195 * Math.cos((base[1] * Math.PI) / 180)), base[1] + dn / 111_195];
    const u = advance(route, session, { pos, accuracyM: opts.accuracy ?? 8, speedMps: speed }, t);
    session = u.session;
    if (u.say) out.say.push(u.say);
    if (u.reroute) out.reroutes++;
    if (u.arrived && out.arrivedAt === null) out.arrivedAt = m;
  }
  out.last = session;
  return out;
}

test('advance: a whole drive is announced in order, once each, ending in the arrival', () => {
  const d = drive();
  assert.deepEqual(d.say, [
    'Head east on Main St',
    'In 500 metres, turn left onto High St',
    'In 150 metres, turn left onto High St',
    'Turn left onto High St',
    'Your destination is in 500 metres',
    'Your destination is in 150 metres',
    'You have arrived at your destination',
  ]);
  assert.equal(d.reroutes, 0);
  assert.ok(d.arrivedAt !== null && d.arrivedAt > 3400);
});

test('advance: the turn is announced at sensible distances, scaled by speed', () => {
  // Wall-clock distance to the turn (2000 m) at each announcement.
  const spokenAt = (speed: number) => {
    let session = newSession();
    const found: Record<string, number> = {};
    for (let m = 0; m < 2000; m += speed) {
      const u = advance(route, session, { pos: posAt(route, m), accuracyM: 8, speedMps: speed }, 0);
      session = u.session;
      if (u.say && !(u.say in found)) found[u.say] = 2000 - m;
    }
    return found;
  };
  const slow = spokenAt(30 / 3.6), fast = spokenAt(100 / 3.6);
  const far = (f: Record<string, number>) => f[Object.keys(f).find((k) => k.startsWith('In ') && k.includes('turn left'))!];
  assert.ok(far(slow) < 400 && far(slow) >= 240, `slow: ${far(slow)}`);
  assert.ok(far(fast) > 900 && far(fast) <= 1200, `fast: ${far(fast)}`);
});

test('advance: nothing is said twice when the GPS stutters or the car stops at the turn', () => {
  const run = (speedMps: number) => {
    let session = newSession();
    const said: string[] = [];
    const feed = (m: number) => {
      const u = advance(route, session, { pos: posAt(route, m), accuracyM: 8, speedMps }, 0);
      session = u.session;
      if (u.say) said.push(u.say);
    };
    feed(0);
    for (const m of [1880, 1885, 1870, 1890, 1890, 1890, 1892, 1960, 1960, 1962]) feed(m);
    return said;
  };
  const rolling = run(V);
  assert.equal(rolling.filter((s) => s.startsWith('In ')).length, 1);
  assert.equal(rolling.filter((s) => s.startsWith('Turn left')).length, 1);
  const stopped = run(0); // at a standstill the distances shrink to 250, 80 and 25 m
  assert.equal(new Set(stopped).size, stopped.length, stopped.join(' | '));
  assert.ok(stopped.length <= 3, stopped.join(' | '));
});

test('advance: driving off the road asks for a reroute once, and says nothing about turns it is not on the road for', () => {
  // On the route to 1000 m, then 120 m south of it for ten seconds.
  const d = drive({ to: 1000 + V * 10, offset: (m) => (m > 1000 ? [0, -120] : [0, 0]) });
  assert.equal(d.reroutes, 1);
  assert.ok(!d.say.some((s) => s.startsWith('Turn left')), d.say.join(' | '));
});

test('advance: a bad fix or two does not reroute', () => {
  const d = drive({ offset: (m) => (Math.round(m / V) % 20 === 7 ? [0, 200] : [0, 0]) });
  assert.equal(d.reroutes, 0);
  assert.ok(d.arrivedAt !== null);
});

test('advance: once arrived it stays arrived and goes quiet', () => {
  const d = drive();
  const u = advance(route, d.last, { pos: posAt(route, route.distanceM - 5), accuracyM: 8, speedMps: 0 }, 99_000);
  assert.equal(u.arrived, true);
  assert.equal(u.say, null);
});

test('advance: starting part-way along, as after a reroute, begins with the new route', () => {
  const d = drive({ from: 1990, to: 2200 });
  assert.equal(d.say[0], 'Head east on Main St');
  assert.ok(!d.say.some((s) => s.includes('turn left')), 'the turn it has just made is not announced again');
});
