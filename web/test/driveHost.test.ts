import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Fix } from '../src/drive/camera.js';
import type { LngLat } from '../src/drive/geometry.js';
import { WEB_API_VERSION, definePlugin, type DriveAlert, type DriveAlertFilter, type DriveSourceContext, type PluginMapClick } from '../src/plugins/api.js';
import { PluginDriveAlerts, PluginDriveToggles } from '../src/plugins/DriveAlerts.js';
import { DriveRunner, type DriveRunnerEnv } from '../src/plugins/driveRunner.js';
import { bannerAlert, nearestAlert } from '../src/plugins/nearestAlert.js';
import { routeAheadM } from '../src/plugins/routeAhead.js';
import { PluginRegistry, type DriveSourceItem } from '../src/plugins/registry.js';

// --- a Drive map that records what it is asked to draw ------------------------------

class FakeDriveMap {
  readonly layers = new Map<string, { id: string; layout: Record<string, unknown> }>();
  readonly sources = new Map<string, unknown>();
  /** Layers with a feature under the next tap. */
  hitLayers: string[] = [];
  addLayer(spec: { id: string }) { this.layers.set(spec.id, { id: spec.id, layout: {} }); }
  addSource(id: string, spec: unknown) { this.sources.set(id, spec); }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { if (!this.layers.delete(id)) throw new Error(`no layer ${id}`); }
  removeSource(id: string) { this.sources.delete(id); }
  getStyle() { return { layers: [...this.layers.values()], sources: Object.fromEntries(this.sources) }; }
  queryRenderedFeatures(_point: unknown, opts: { layers: string[] }) {
    return this.hitLayers.filter((id) => opts.layers.includes(id)).map((id) => ({ layer: { id }, properties: {} }));
  }
}

const asMap = (m: FakeDriveMap) => m as unknown as MapLibreMap;
const ROUTE: LngLat[] = [[151.2, -33.87], [151.3, -33.87]];
const CAR: LngLat = [151.205, -33.87];

function fixAt(lng: number, lat: number, over: Partial<Fix> = {}): Fix {
  return { lng, lat, accuracy: 5, speed: 15, heading: 90, t: Date.now(), ...over };
}

/** The Drive screen's side of the runner, as mutable state the tests can change. */
function world() {
  const state = {
    fix: fixAt(CAR[0], CAR[1]) as Fix | null,
    route: null as LngLat[] | null,
    heading: null as number | null,
    voice: true,
    spoken: [] as string[],
  };
  const env: DriveRunnerEnv = {
    fix: () => state.fix,
    route: () => state.route,
    heading: () => state.heading,
    voiceOn: () => state.voice,
    speak: (text) => { state.spoken.push(text); },
  };
  return { state, env };
}

function item(local: string, start: DriveSourceItem['start'], over: Partial<DriveSourceItem> = {}): DriveSourceItem {
  return { id: `pl:${local}`, pluginId: 'pl', label: local, on: true, filter: 'nearby', runs: 'drive', start, ...over };
}

const quiet = () => mock.method(console, 'error', () => {});

// --- route-ahead: the road-ahead rule, pinned by fixed cases -----------------------------

test('routeAhead: a point on the road ahead gets its distance; behind, off the road or too far ahead gets none', () => {
  const route: [number, number][] = [[151.2, -33.87], [151.3, -33.87]];
  // 0.005 degrees of longitude at 33.87 S is about 462 m.
  const ahead = routeAheadM(route, CAR, [151.21, -33.87]);
  assert.ok(ahead !== null && ahead > 455 && ahead < 470, `about 462 m ahead, got ${ahead}`);
  assert.equal(routeAheadM(route, CAR, [151.201, -33.87]), null, 'behind the car');
  assert.equal(routeAheadM(route, CAR, [151.21, -33.872]), null, 'a parallel road about 220 m off');
  assert.equal(routeAheadM(route, CAR, [151.21, -33.8705]), null, 'a road about 55 m off the route');
  assert.equal(routeAheadM(route, CAR, [151.25, -33.87]), null, 'about 4 km ahead, past the 1500 m window');
  assert.equal(routeAheadM(route, [151.205, -33.88], [151.21, -33.87]), null, 'a car more than 100 m off the route gets no answers');
});

test('routeAhead: aheadM widens the window, offRoadM narrows the road, and short routes give nothing', () => {
  const route: [number, number][] = [[151.2, -33.87], [151.3, -33.87]];
  const far: LngLat = [151.25, -33.87];
  assert.equal(routeAheadM(route, CAR, far), null, 'core stops at 1500 m');
  const d = routeAheadM(route, CAR, far, { aheadM: 5000 });
  assert.ok(d !== null && d > 4100 && d < 4200, `about 4.1 km ahead, got ${d}`);
  assert.equal(routeAheadM(route, CAR, [151.21, -33.8705], { offRoadM: 20 }), null);
  assert.equal(routeAheadM([CAR], CAR, [151.21, -33.87]), null);
});

// --- the banner ----------------------------------------------------------------------

test('the banner: a nearby source is judged in a straight line, a route-ahead source by the road ahead', () => {
  const sideStreet: DriveAlert = { id: 'side', point: [151.2075, -33.871], title: 'Side street' };
  const onRoad: DriveAlert = { id: 'road', point: [151.21, -33.87], title: 'Ahead' };
  const routeOnly = (id: string): DriveAlertFilter => (id === 'pl:route' ? 'route-ahead' : 'nearby');

  assert.equal(bannerAlert({ 'pl:route': [sideStreet] }, routeOnly, ROUTE, CAR), null, 'a side street is not on the road ahead');
  const ahead = bannerAlert({ 'pl:route': [sideStreet, onRoad] }, routeOnly, ROUTE, CAR);
  assert.equal(ahead?.alert.id, 'road');
  assert.equal(ahead?.ahead, true);
  assert.equal(ahead?.sourceId, 'pl:route');

  const nearby = bannerAlert({ 'pl:nearby': [sideStreet] }, () => 'nearby', ROUTE, CAR);
  assert.equal(nearby?.alert.id, 'side');
  assert.equal(nearby?.ahead, false);
  assert.equal(nearestAlert({ x: [sideStreet] }, CAR)?.sourceId, 'x');
});

// --- the registry: on/off, filter, title -----------------------------------------------

test('a drive source is on by default, may start off, carries its filter and title, and the button flips it', async () => {
  const registry = new PluginRegistry({ storage: null });
  await registry.activate({ id: 'pl', name: 'P', version: '1.0.0' }, definePlugin({
    activate(host) {
      host.drive.addAlertSource({ id: 'a', label: 'Alpha', start: () => {} });
      host.drive.addAlertSource({ id: 'b', label: 'Beta', title: 'Beta warnings', defaultOn: false, filter: 'route-ahead', start: () => {} });
      assert.throws(() => host.drive.addAlertSource({ id: 'c', label: 'C', filter: 'sideways' as never, start: () => {} }), /filter/);
      assert.throws(() => host.drive.addAlertSource({ id: 'c', label: 'C', runs: 'sometimes' as never, start: () => {} }), /runs/);
      host.drive.addAlertSource({ id: 'd', label: 'Delta', runs: 'always', start: () => {} });
    },
  }));
  const [a, b, d] = registry.getSnapshot().driveSources;
  assert.deepEqual([a.id, a.on, a.filter, a.runs], ['pl:a', true, 'nearby', 'drive']);
  assert.deepEqual([b.on, b.filter, b.title], [false, 'route-ahead', 'Beta warnings']);
  assert.equal(d.runs, 'always');
  registry.setDriveSourceOn('pl:b', true);
  assert.equal(registry.getSnapshot().driveSources[1].on, true);
  registry.setDriveSourceOn('pl:missing', false);
  assert.equal(WEB_API_VERSION, '1.1.0');
});

// --- the runner ----------------------------------------------------------------------

test('the runner starts the sources that are on, and their context reads the live drive', () => {
  const { state, env } = world();
  state.route = ROUTE;
  state.heading = 90;
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let changes = 0;
  runner.subscribe(() => { changes++; });
  const seen: unknown[] = [];
  runner.sync([
    item('on', (ctx) => {
      seen.push([ctx.position(), ctx.route()?.length, ctx.heading()]);
      ctx.report([{ id: 'a', point: [151.21, -33.87], title: 'Hazard' }]);
    }),
    item('off', () => assert.fail('an off source must not start'), { on: false }),
  ]);
  assert.deepEqual(seen, [[CAR, 2, 90]]);
  assert.equal(runner.getSnapshot().alerts['pl:on']?.[0].id, 'a');
  assert.equal(runner.getSnapshot().alerts['pl:off'], undefined);
  assert.ok(changes > 0, 'subscribers hear about the report');

  runner.stopAll();
  assert.equal(runner.getSnapshot().alerts['pl:on'], undefined, 'the drive ends and the alerts go');
});

test("runs 'always': the source starts with the map, so its pins show while planning; speech and drive-only sources wait for a drive", () => {
  const { state, env } = world();
  state.route = ROUTE;
  const map = new FakeDriveMap();
  const runner = new DriveRunner(asMap(map), env);
  let ctx!: DriveSourceContext;
  let tripStarts = 0;
  const plan = item('plan', (c) => {
    ctx = c;
    (c.map as unknown as FakeDriveMap).addLayer({ id: c.scopedId('pins') });
    c.mapLayers([c.scopedId('pins')], { onTap: () => {} });
    c.report([{ id: 'p', point: CAR, title: 'Pin' }]);
  }, { runs: 'always' });
  const trip = item('trip', () => { tripStarts++; });

  runner.sync([plan, trip], false);
  assert.equal(tripStarts, 0, 'a drive-only source waits for a drive');
  assert.ok(map.layers.has('pl:plan:pins'), 'the always source draws while planning');
  assert.equal(runner.getSnapshot().alerts['pl:plan']?.[0].id, 'p');
  assert.equal(ctx.speak('Planning'), false, 'nothing is said outside a drive');

  runner.sync([plan, trip], true);
  assert.equal(tripStarts, 1);
  assert.equal(ctx.speak('Driving'), true, 'once a drive is on, the always source may speak too');
  runner.sync([plan, trip], false);
  assert.equal(tripStarts, 1);
  assert.ok(map.layers.has('pl:plan:pins'), 'the always source keeps its pins when the drive ends');

  runner.stopAll();
  assert.equal(map.layers.has('pl:plan:pins'), false, 'closing the Drive screen takes them off');
});

test('routeAhead in the context needs a route and a fix', () => {
  const { state, env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  const answers: (number | null)[] = [];
  runner.sync([item('x', (ctx) => {
    answers.push(ctx.routeAhead([151.21, -33.87]));
    state.route = ROUTE;
    answers.push(ctx.routeAhead([151.21, -33.87]));
    answers.push(ctx.routeAhead([151.2, -33.87]));
  })]);
  assert.equal(answers[0], null, 'no route yet');
  assert.ok(answers[1] !== null && answers[1] > 450 && answers[1] < 470, `about 460 m ahead, got ${answers[1]}`);
  assert.equal(answers[2], null, 'behind the car');
});

test('speech goes through the Drive voice, is gated by voice and fix, and each key speaks once per drive', () => {
  const { state, env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let ctx!: DriveSourceContext;
  runner.sync([item('talk', (c) => { ctx = c; })]);

  assert.equal(ctx.speak('Police ahead', { key: 'a1' }), true);
  assert.equal(ctx.speak('Police ahead', { key: 'a1' }), false, 'a keyed prompt is said once');
  assert.equal(ctx.speak('Plain'), true);
  assert.deepEqual(state.spoken, ['Police ahead', 'Plain']);

  state.voice = false;
  assert.equal(ctx.speak('Muted', { key: 'a2' }), false);
  state.voice = true;
  assert.equal(ctx.speak('Unmuted', { key: 'a2' }), true, 'a muted key is not recorded, so it can still be said');

  state.fix = fixAt(CAR[0], CAR[1], { t: Date.now() - 11_000 });
  assert.equal(ctx.speak('Stale', { key: 'a3' }), false, 'older than 10 s');
  state.fix = fixAt(CAR[0], CAR[1], { accuracy: 80 });
  assert.equal(ctx.speak('Loose', { key: 'a3' }), false, 'worse than 75 m');
  state.fix = null;
  assert.equal(ctx.speak('No fix'), false);
  state.fix = fixAt(CAR[0], CAR[1]);

  runner.stopAll();
  let ctx2!: DriveSourceContext;
  runner.sync([item('talk', (c) => { ctx2 = c; })]);
  assert.equal(ctx2.speak('Police ahead', { key: 'a1' }), true, 'a new drive says it again');
  assert.throws(() => ctx2.speak(''), /speak text/);
});

test('status: shown for states other than ok, cleared with null, and checked', () => {
  const { env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let ctx!: DriveSourceContext;
  runner.sync([item('x', (c) => { ctx = c; })]);
  ctx.setStatus({ state: 'checking', text: 'Checking reports for this area…' });
  assert.deepEqual(runner.getSnapshot().status['pl:x'], { state: 'checking', text: 'Checking reports for this area…' });
  ctx.setStatus({ state: 'ok', text: 'All good' });
  assert.equal(runner.getSnapshot().status['pl:x'], undefined, 'ok is shown as nothing');
  ctx.setStatus({ state: 'error', text: 'Reports unavailable' });
  assert.equal(runner.getSnapshot().status['pl:x']?.state, 'error');
  ctx.setStatus(null);
  assert.equal(runner.getSnapshot().status['pl:x'], undefined);
  assert.throws(() => ctx.setStatus({ state: 'loud' as never, text: 'x' }), /setStatus/);
});

test('pins: scoped ids are removed when the source stops, and another source keeps its own', () => {
  const { env } = world();
  const map = new FakeDriveMap();
  const runner = new DriveRunner(asMap(map), env);
  let cleaned = 0;
  const draw = (ctx: DriveSourceContext) => {
    const m = ctx.map as unknown as FakeDriveMap;
    m.addSource(ctx.scopedId('src'), { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: ctx.scopedId('dots') });
    ctx.mapLayers([ctx.scopedId('dots')]);
  };
  runner.sync([
    item('pins', (ctx) => { draw(ctx); return () => { cleaned++; }; }),
    item('other', draw),
  ]);
  assert.deepEqual([...map.layers.keys()].sort(), ['pl:other:dots', 'pl:pins:dots']);
  assert.deepEqual([...map.sources.keys()].sort(), ['pl:other:src', 'pl:pins:src']);

  runner.sync([item('pins', () => {}, { on: false }), item('other', draw)]);
  assert.equal(cleaned, 1, 'the cleanup ran');
  assert.deepEqual([...map.layers.keys()], ['pl:other:dots']);
  assert.deepEqual([...map.sources.keys()], ['pl:other:src']);
});

test('a tap on a plugin pin goes to its onTap and is not a destination pick; unclaimed taps fall through', () => {
  const { env } = world();
  const map = new FakeDriveMap();
  const runner = new DriveRunner(asMap(map), env);
  const taps: PluginMapClick[] = [];
  let release!: () => void;
  runner.sync([item('pins', (ctx) => {
    const m = ctx.map as unknown as FakeDriveMap;
    m.addLayer({ id: ctx.scopedId('dots') });
    m.addLayer({ id: ctx.scopedId('extra') });
    ctx.mapLayers([ctx.scopedId('dots')], { onTap: (t) => { taps.push(t); } });
    release = ctx.mapLayers([ctx.scopedId('extra')], { onTap: () => { taps.push({} as PluginMapClick); } });
  })]);
  const tap = { point: { x: 5, y: 6 }, lngLat: { lng: 151.2, lat: -33.87 } };

  assert.equal(runner.tap(tap), false, 'nothing under the tap');
  map.hitLayers = ['pl:pins:dots'];
  assert.equal(runner.tap(tap), true);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].layerId, 'pl:pins:dots');
  assert.deepEqual(taps[0].lngLat, [151.2, -33.87]);

  map.hitLayers = ['pl:pins:extra'];
  assert.equal(runner.tap(tap), true, 'the second claim owns its layer too');
  release();
  assert.equal(runner.tap(tap), false, 'a released claim no longer owns its layer');
});

test('a source that throws on start is contained: the others run, and it waits for the driver to turn it on again', () => {
  const { env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  const q = quiet();
  let attempts = 0;
  const bad = () => item('bad', () => { attempts++; throw new Error('boom'); });
  const good = item('good', (ctx) => ctx.report([{ id: 'g', point: CAR, title: 'Good' }]));
  runner.sync([bad(), good]);
  runner.sync([bad(), good]);
  assert.equal(attempts, 1, 'not retried on every registry change');
  assert.deepEqual(Object.keys(runner.getSnapshot().alerts), ['pl:good']);
  assert.ok(q.mock.callCount() >= 1, 'the failure is logged');
  runner.sync([bad(), good]);
  runner.sync([item('bad', () => {}, { on: false }), good]);
  runner.sync([bad(), good]);
  assert.equal(attempts, 2, 'turned off and on again, it tries again');
  q.mock.restore();
});

test('a late report from a stopped source is ignored, and a throwing cleanup does not stop the others', () => {
  const { env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  const q = quiet();
  let late!: DriveSourceContext;
  let other = 0;
  runner.sync([
    item('x', (ctx) => { late = ctx; return () => { throw new Error('cleanup broke'); }; }),
    item('y', () => () => { other++; }),
  ]);
  runner.stopAll();
  late.report([{ id: 'late', point: CAR, title: 'Late' }]);
  assert.equal(runner.getSnapshot().alerts['pl:x'], undefined);
  assert.equal(other, 1, 'the second cleanup still ran');
  q.mock.restore();
});

// --- the React slot: what a driver sees -----------------------------------------------

test('the banner, status lines and on/off buttons render from the runner and the registry', async () => {
  const registry = new PluginRegistry({ storage: null });
  await registry.activate({ id: 'pl', name: 'P', version: '1.0.0' }, definePlugin({
    activate(host) {
      host.drive.addAlertSource({ id: 'road', label: 'Road', filter: 'route-ahead', start: (ctx) => {
        ctx.report([{ id: 'r', point: [151.21, -33.87], title: 'Hazard', glyph: '⚠️' }]);
        ctx.setStatus({ state: 'checking', text: 'Checking the road ahead…' });
      } });
      host.drive.addAlertSource({ id: 'off', label: 'Off one', defaultOn: false, start: () => {} });
    },
  }));
  const { state, env } = world();
  state.route = ROUTE;
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  runner.sync(registry.getSnapshot().driveSources);

  const html = renderToStaticMarkup(createElement(PluginDriveAlerts, { runner, fix: state.fix, route: ROUTE, driving: true, registry }));
  assert.match(html, /Hazard/);
  assert.match(html, /\d+ m ahead/);
  assert.match(html, /drive__status drive__status--checking/);
  assert.match(html, /Checking the road ahead…/);

  // While planning, the banner waits for the drive, but the status line still shows.
  const planning = renderToStaticMarkup(createElement(PluginDriveAlerts, { runner, fix: state.fix, route: ROUTE, driving: false, registry }));
  assert.doesNotMatch(planning, /drive__report/);
  assert.match(planning, /Checking the road ahead…/);

  const toggles = renderToStaticMarkup(createElement(PluginDriveToggles, { registry }));
  assert.match(toggles, /aria-pressed="true"[^>]*>Road on</);
  assert.match(toggles, /aria-pressed="false"[^>]*>Off one off</);
});
