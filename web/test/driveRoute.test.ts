import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowFor, describeManeuver, fetchNavRoute, parseNavRoute, parseTo, stopsAhead, stopsForSavedRoute } from '../src/drive/route.js';
import { at, densify, navL, osrmL, step } from './driveFixtures.js';

const near = (a: number, b: number, eps = 1) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('parseNavRoute: steps start where their manoeuvres happen, and the last is the arrival at the end', () => {
  const r = navL();
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => Math.round(s.startM)), [0, 2000, 3500]);
  near(r.distanceM, 3500);
  assert.equal(r.durationS, 250);
  assert.equal(r.steps[0].text, 'Head east on Main St');
  assert.equal(r.steps[1].text, 'Turn left onto High St');
  assert.equal(r.steps[2].maneuver.type, 'arrive');
  assert.equal(r.cum.length, r.coords.length);
});

test('parseNavRoute: step lengths are made to agree with the line when OSRM rounds differently', () => {
  const data = osrmL();
  data.routes[0].legs[0].steps[0].distance = 1990; // 10 m short
  const r = parseNavRoute(data)!;
  near(r.steps[1].startM, 1990 * (3500 / 3490), 0.5);
  near(r.steps[2].startM, r.distanceM, 0.001);
});

test('parseNavRoute: the stops of a saved route are not arrivals', () => {
  // Two legs: Main St to a waypoint, then on along High St.
  const data = {
    code: 'Ok',
    routes: [{
      distance: 3500, duration: 250,
      geometry: { coordinates: densify([[0, 0], [2000, 0], [2000, 1500]]) },
      legs: [
        { steps: [step('depart', undefined, 'Main St', 1500), step('arrive', 'straight', 'Main St', 0)] },
        { steps: [step('depart', undefined, 'Main St', 500), step('turn', 'left', 'High St', 1500), step('arrive', undefined, 'High St', 0)] },
      ],
    }],
  };
  const r = parseNavRoute(data)!;
  assert.deepEqual(r.steps.map((s) => s.maneuver.type), ['depart', 'turn', 'arrive']);
  near(r.steps[0].distanceM, 2000);
  near(r.steps[1].startM, 2000);
});

test('parseNavRoute: refuses what is not a route', () => {
  assert.equal(parseNavRoute(null), null);
  assert.equal(parseNavRoute({ code: 'NoRoute' }), null);
  assert.equal(parseNavRoute({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2]] } }] }), null);
  assert.equal(parseNavRoute({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2], [1, null]] }, legs: [] }] }), null);
  assert.equal(parseNavRoute({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2], [3, 4]] }, legs: [] }] }), null, 'no steps, nothing to guide');
});

test('describeManeuver: the wording of the common manoeuvres', () => {
  const d = (type: string, modifier?: string, name = 'Pacific Hwy', extra: Record<string, unknown> = {}) => describeManeuver({ type, modifier, ...extra }, name);
  assert.equal(d('turn', 'right'), 'Turn right onto Pacific Hwy');
  assert.equal(d('turn', 'slight left'), 'Bear left onto Pacific Hwy');
  assert.equal(d('turn', 'sharp right'), 'Turn sharp right onto Pacific Hwy');
  assert.equal(d('turn', 'uturn'), 'Make a U-turn onto Pacific Hwy');
  assert.equal(d('turn', 'straight'), 'Continue straight onto Pacific Hwy');
  assert.equal(d('turn', 'left', ''), 'Turn left');
  assert.equal(d('new name', 'straight'), 'Continue onto Pacific Hwy');
  assert.equal(d('end of road', 'left'), 'At the end of the road, turn left onto Pacific Hwy');
  assert.equal(d('merge', 'slight right'), 'Merge right onto Pacific Hwy');
  assert.equal(d('on ramp', 'right'), 'Take the ramp on the right onto Pacific Hwy');
  assert.equal(d('off ramp', 'left'), 'Take the exit on the left onto Pacific Hwy');
  assert.equal(d('fork', 'slight left'), 'Keep left at the fork onto Pacific Hwy');
  assert.equal(d('roundabout', 'right', 'Pacific Hwy', { exit: 2 }), 'At the roundabout, take the 2nd exit onto Pacific Hwy');
  assert.equal(d('rotary', 'left', '', { exit: 1 }), 'At the roundabout, take the 1st exit');
  assert.equal(d('roundabout turn', 'left'), 'At the roundabout, turn left onto Pacific Hwy');
  assert.equal(d('depart', undefined, 'Main St', { bearingAfter: 200 }), 'Head south on Main St');
  assert.equal(d('depart', undefined, '', {}), 'Head off');
  assert.equal(d('arrive', 'left'), 'Arrive at your destination, on the left');
  assert.equal(d('something new'), 'Continue straight onto Pacific Hwy', 'an unknown manoeuvre still says something');
});

test('arrowFor: shape and rotation', () => {
  assert.deepEqual(arrowFor({ type: 'turn', modifier: 'right' }), { shape: 'arrow', angle: 90 });
  assert.deepEqual(arrowFor({ type: 'turn', modifier: 'slight left' }), { shape: 'arrow', angle: -45 });
  assert.deepEqual(arrowFor({ type: 'new name' }), { shape: 'arrow', angle: 0 });
  assert.deepEqual(arrowFor({ type: 'turn', modifier: 'uturn' }), { shape: 'uturn', angle: 0 });
  assert.deepEqual(arrowFor({ type: 'roundabout', modifier: 'left', exit: 3 }), { shape: 'roundabout', angle: -90 });
  assert.equal(arrowFor({ type: 'arrive', modifier: 'left' }).shape, 'arrive');
});

test('parseTo: lat,lng from the address bar', () => {
  assert.deepEqual(parseTo('-33.42,149.58'), { lat: -33.42, lng: 149.58 });
  assert.deepEqual(parseTo(' -33 , 149 '), { lat: -33, lng: 149 });
  for (const bad of [null, '', 'x,y', '91,0', '0,181', '1,2,3', '1;2']) assert.equal(parseTo(bad), null, String(bad));
});

test('stopsAhead: keeps the stops the car has not yet passed', () => {
  const r = navL();
  const stops: [number, number][] = [at(1000, 0), at(2000, 700), at(2000, 1500)];
  assert.deepEqual(stopsAhead(r, stops, 0), stops);
  assert.deepEqual(stopsAhead(r, stops, 1500), stops.slice(1));
  assert.deepEqual(stopsAhead(r, stops, 3400), stops.slice(2));
});

test('stopsForSavedRoute: starts from the driver unless already at the start, and stays within the limit', () => {
  const wps: [number, number][] = Array.from({ length: 40 }, (_, i) => at(i * 500, 0));
  const far = stopsForSavedRoute(wps, at(-5000, 0));
  assert.equal(far.length, 25);
  assert.deepEqual(far[0], at(-5000, 0));
  assert.deepEqual(far.at(-1), wps.at(-1));
  const atStart = stopsForSavedRoute(wps.slice(0, 3), at(20, 0));
  assert.deepEqual(atStart, wps.slice(0, 3));
  assert.deepEqual(stopsForSavedRoute(wps.slice(0, 3), null), wps.slice(0, 3));
});

test('fetchNavRoute: asks the server for steps, and turns failures into messages a driver can read', async () => {
  const real = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(JSON.stringify(osrmL())); };
    const r = await fetchNavRoute([[151, -33], [151.1, -33.1]]);
    assert.equal(r.steps.length, 3);
    assert.equal(urls[0], '/api/route?coords=151,-33;151.1,-33.1&steps=1');

    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(fetchNavRoute([[1, 2], [3, 4]]), /Sign in/);
    globalThis.fetch = async () => new Response('{}', { status: 502 });
    await assert.rejects(fetchNavRoute([[1, 2], [3, 4]]), /not answering/);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'NoRoute' }));
    await assert.rejects(fetchNavRoute([[1, 2], [3, 4]]), /No driving route/);
  } finally { globalThis.fetch = real; }
});
