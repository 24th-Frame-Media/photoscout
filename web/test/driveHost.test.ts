import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Map as MapLibreMap, Popup } from 'maplibre-gl';
import type { Fix } from '../src/drive/camera.js';
import type { LngLat } from '../src/drive/geometry.js';
import {
  WEB_API_VERSION,
  definePlugin,
  type DriveAlert,
  type DriveFix,
  type DriveImage,
  type DriveSourceContext,
  type PluginMapClick,
} from '../src/plugins/api.js';
import { PluginDriveAlerts, PluginDriveToggles } from '../src/plugins/DriveAlerts.js';
import { DriveRunner, type DriveRunnerEnv } from '../src/plugins/driveRunner.js';
import { DRIVE_TUNING_DEFAULTS } from '../src/plugins/driveTuning.js';
import { bannerAlert, nearestAlert, type BannerSource } from '../src/plugins/nearestAlert.js';
import { routeAheadM } from '../src/plugins/routeAhead.js';
import { PluginRegistry, type DriveSourceItem } from '../src/plugins/registry.js';

// --- a Drive map that records what it is asked to draw ------------------------------

class FakeDriveMap {
  readonly layers = new Map<string, { id: string; layout: Record<string, unknown> }>();
  readonly sources = new Map<string, unknown>();
  readonly images = new Map<string, unknown>();
  /** Adds of a name that was already there, and removals of a name that was not: maplibre reports both as errors. */
  readonly imageErrors: string[] = [];
  /** Layers with a feature under the next tap. */
  hitLayers: string[] = [];
  addLayer(spec: { id: string }) { this.layers.set(spec.id, { id: spec.id, layout: {} }); }
  addSource(id: string, spec: unknown) { this.sources.set(id, spec); }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { if (!this.layers.delete(id)) throw new Error(`no layer ${id}`); }
  removeSource(id: string) { this.sources.delete(id); }
  addImage(id: string, image: unknown) { if (this.images.has(id)) this.imageErrors.push(id); this.images.set(id, image); }
  hasImage(id: string) { return this.images.has(id); }
  removeImage(id: string) { if (!this.images.delete(id)) this.imageErrors.push(id); }
  getStyle() { return { layers: [...this.layers.values()], sources: Object.fromEntries(this.sources) }; }
  queryRenderedFeatures(_point: unknown, opts: { layers: string[] }) {
    return this.hitLayers.filter((id) => opts.layers.includes(id)).map((id) => ({ layer: { id }, properties: {} }));
  }
}

/** A popup that records what it was given; the host builds one per `showPopup` through `createPopup`. */
class FakePopup {
  at: LngLat | null = null;
  text: string | null = null;
  dom: unknown = null;
  added: unknown = null;
  removed = 0;
  setLngLat(at: LngLat) { this.at = at; return this; }
  setText(text: string) { this.text = text; return this; }
  setDOMContent(el: unknown) { this.dom = el; return this; }
  addTo(map: unknown) { this.added = map; return this; }
  remove() { this.removed++; return this; }
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
    popups: [] as FakePopup[],
  };
  const env: DriveRunnerEnv = {
    fix: () => state.fix,
    route: () => state.route,
    heading: () => state.heading,
    voiceOn: () => state.voice,
    speak: (text) => { state.spoken.push(text); },
    createPopup: () => {
      const popup = new FakePopup();
      state.popups.push(popup);
      return popup as unknown as Popup;
    },
  };
  return { state, env };
}

function item(local: string, start: DriveSourceItem['start'], over: Partial<DriveSourceItem> = {}): DriveSourceItem {
  return { id: `pl:${local}`, pluginId: 'pl', label: local, on: true, filter: 'nearby', runs: 'drive', tuning: DRIVE_TUNING_DEFAULTS, start, ...over };
}

const quiet = () => mock.method(console, 'error', () => {});

/** The banner's view of a source: 'pl:route' filters by the road ahead, everything else by straight-line distance. */
const bannerOf = (id: string): BannerSource => ({ filter: id === 'pl:route' ? 'route-ahead' : 'nearby', tuning: DRIVE_TUNING_DEFAULTS });

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

test('routeAhead: the window widens with aheadM, narrows with offRoadM, and short routes give nothing', () => {
  const route: [number, number][] = [[151.2, -33.87], [151.3, -33.87]];
  const far: LngLat = [151.25, -33.87];
  assert.equal(routeAheadM(route, CAR, far), null, 'core stops at 1500 m');
  const d = routeAheadM(route, CAR, far, { aheadM: 5000 });
  assert.ok(d !== null && d > 4100 && d < 4200, `about 4.1 km ahead, got ${d}`);
  assert.equal(routeAheadM(route, CAR, [151.21, -33.8705], { offRoadM: 20 }), null);
  assert.equal(routeAheadM(route, CAR, [151.21, -33.8705], { onRouteM: 40 }), null, 'a car 55 m off the route is out of a 40 m window');
  assert.equal(routeAheadM([CAR], CAR, [151.21, -33.87]), null);
});

// --- the banner ----------------------------------------------------------------------

test('the banner: a nearby source is judged in a straight line, a route-ahead source by the road ahead', () => {
  const sideStreet: DriveAlert = { id: 'side', point: [151.2075, -33.871], title: 'Side street' };
  const onRoad: DriveAlert = { id: 'road', point: [151.21, -33.87], title: 'Ahead' };

  assert.equal(bannerAlert({ 'pl:route': [sideStreet] }, bannerOf, ROUTE, CAR), null, 'a side street is not on the road ahead');
  const ahead = bannerAlert({ 'pl:route': [sideStreet, onRoad] }, bannerOf, ROUTE, CAR);
  assert.equal(ahead?.alert.id, 'road');
  assert.equal(ahead?.ahead, true);
  assert.equal(ahead?.sourceId, 'pl:route');

  const nearby = bannerAlert({ 'pl:nearby': [sideStreet] }, () => bannerOf('pl:nearby'), ROUTE, CAR);
  assert.equal(nearby?.alert.id, 'side');
  assert.equal(nearby?.ahead, false);
  assert.equal(nearestAlert({ x: [sideStreet] }, CAR)?.sourceId, 'x');
});

test('the banner uses each source\'s own tuning: nearbyM widens one source, onRouteM narrows another', () => {
  // About 1.4 km east of the car: past the 800 m default, inside 2000 m.
  const far: DriveAlert = { id: 'far', point: [151.22, -33.87], title: 'Far' };
  const wide: BannerSource = { filter: 'nearby', tuning: { ...DRIVE_TUNING_DEFAULTS, nearbyM: 2000 } };
  assert.equal(bannerAlert({ 'pl:n': [far] }, () => ({ filter: 'nearby', tuning: DRIVE_TUNING_DEFAULTS }), ROUTE, CAR), null);
  assert.equal(bannerAlert({ 'pl:n': [far] }, () => wide, ROUTE, CAR)?.alert.id, 'far');

  // The car sits 55 m off the route: a route-ahead source with the default 100 m window still counts; one with 40 m does not.
  const offRoute: LngLat = [151.205, -33.8705];
  const onRoad: DriveAlert = { id: 'road', point: [151.21, -33.87], title: 'Ahead' };
  const narrow: BannerSource = { filter: 'route-ahead', tuning: { ...DRIVE_TUNING_DEFAULTS, onRouteM: 40 } };
  assert.equal(bannerAlert({ 'pl:route': [onRoad] }, bannerOf, ROUTE, offRoute)?.alert.id, 'road');
  assert.equal(bannerAlert({ 'pl:route': [onRoad] }, () => narrow, ROUTE, offRoute), null);
});

// --- the registry: on/off, filter, title, tuning -----------------------------------------

test('a drive source is on by default, may start off, carries its filter, title and tuning, and the button flips it', async () => {
  const registry = new PluginRegistry({ storage: null });
  await registry.activate({ id: 'pl', name: 'P', version: '1.0.0' }, definePlugin({
    activate(host) {
      host.drive.addAlertSource({ id: 'a', label: 'Alpha', start: () => {} });
      host.drive.addAlertSource({ id: 'b', label: 'Beta', title: 'Beta warnings', defaultOn: false, filter: 'route-ahead', start: () => {} });
      assert.throws(() => host.drive.addAlertSource({ id: 'c', label: 'C', filter: 'sideways' as never, start: () => {} }), /filter/);
      assert.throws(() => host.drive.addAlertSource({ id: 'c', label: 'C', runs: 'sometimes' as never, start: () => {} }), /runs/);
      host.drive.addAlertSource({ id: 'd', label: 'Delta', runs: 'always', start: () => {} });
      host.drive.addAlertSource({ id: 'e', label: 'Echo', tuning: { nearbyM: 2000, speakMaxAccuracyM: 30 }, start: () => {} });
      assert.throws(() => host.drive.addAlertSource({ id: 'f', label: 'F', tuning: { nearbym: 2000 } as never, start: () => {} }), /no option "nearbym"/);
      assert.throws(() => host.drive.addAlertSource({ id: 'f', label: 'F', tuning: { speakMaxAgeMs: 500 }, start: () => {} }), /speakMaxAgeMs/);
      assert.throws(() => host.drive.addAlertSource({ id: 'f', label: 'F', tuning: { nearbyM: Number.NaN }, start: () => {} }), /nearbyM/);
      assert.throws(() => host.drive.addAlertSource({ id: 'f', label: 'F', tuning: 'wide' as never, start: () => {} }), /tuning must be an object/);
      assert.throws(() => host.drive.addAlertSource({ id: 'f', label: 'F', tuning: { toString: 1 } as never, start: () => {} }), /no option "toString"/);
    },
  }));
  const [a, b, d, e] = registry.getSnapshot().driveSources;
  assert.deepEqual([a.id, a.on, a.filter, a.runs], ['pl:a', true, 'nearby', 'drive']);
  assert.deepEqual(a.tuning, DRIVE_TUNING_DEFAULTS, 'a source that sets no tuning gets the host rules');
  assert.deepEqual([b.on, b.filter, b.title], [false, 'route-ahead', 'Beta warnings']);
  assert.equal(d.runs, 'always');
  assert.deepEqual(e.tuning, { ...DRIVE_TUNING_DEFAULTS, nearbyM: 2000, speakMaxAccuracyM: 30 }, 'set options replace the defaults, the rest keep them');
  registry.setDriveSourceOn('pl:b', true);
  assert.equal(registry.getSnapshot().driveSources[1].on, true);
  registry.setDriveSourceOn('pl:missing', false);
  assert.equal(WEB_API_VERSION, '2.0.0');
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
  const got: { fix: DriveFix | null } = { fix: null };
  runner.sync([
    item('on', (ctx) => {
      seen.push([ctx.route()?.length, ctx.heading()]);
      got.fix = ctx.fix();
      ctx.report([{ id: 'a', point: [151.21, -33.87], title: 'Hazard' }]);
    }),
    item('off', () => assert.fail('an off source must not start'), { on: false }),
  ]);
  assert.deepEqual(seen, [[2, 90]]);
  const fixSeen = got.fix;
  assert.ok(fixSeen !== null, 'the fix is there');
  assert.deepEqual({ point: fixSeen.point, accuracyM: fixSeen.accuracyM }, { point: CAR, accuracyM: 5 });
  assert.ok(fixSeen.ageMs >= 0 && fixSeen.ageMs < 5_000, 'the fix carries its age');
  assert.equal(runner.getSnapshot().alerts['pl:on']?.[0].id, 'a');
  assert.equal(runner.getSnapshot().alerts['pl:off'], undefined);
  assert.ok(changes > 0, 'subscribers hear about the report');

  runner.stopAll();
  assert.equal(runner.getSnapshot().alerts['pl:on'], undefined, 'the drive ends and the alerts go');
});

test('fix() is null before the first fix', () => {
  const { state, env } = world();
  state.fix = null;
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let got: DriveFix | null | undefined;
  runner.sync([item('x', (ctx) => { got = ctx.fix(); })]);
  assert.equal(got, null);
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
  assert.deepEqual(ctx.speak('Planning'), { spoken: false, reason: 'not-driving' }, 'nothing is said outside a drive');

  runner.sync([plan, trip], true);
  assert.equal(tripStarts, 1);
  assert.deepEqual(ctx.speak('Driving'), { spoken: true }, 'once a drive is on, the always source may speak too');
  runner.sync([plan, trip], false);
  assert.equal(tripStarts, 1);
  assert.ok(map.layers.has('pl:plan:pins'), 'the always source keeps its pins when the drive ends');

  runner.stopAll();
  assert.equal(map.layers.has('pl:plan:pins'), false, 'closing the Drive screen takes them off');
});

test('routeAhead in the context needs a route and a fix; the source\'s aheadM applies to it', () => {
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

  const far: LngLat = [151.25, -33.87];
  const seen: Record<string, number | null> = {};
  runner.sync([
    item('default', (ctx) => { seen.default = ctx.routeAhead(far); }),
    item('wide', (ctx) => { seen.wide = ctx.routeAhead(far); }, { tuning: { ...DRIVE_TUNING_DEFAULTS, aheadM: 5000 } }),
  ]);
  assert.equal(seen.default, null, 'the host window stops at 1500 m');
  assert.ok(seen.wide !== null && seen.wide > 4100 && seen.wide < 4200, `about 4.1 km ahead for aheadM 5000, got ${seen.wide}`);
});

test('speech goes through the Drive voice, is gated by voice and fix, and says why it did not', () => {
  const { state, env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let ctx!: DriveSourceContext;
  runner.sync([item('talk', (c) => { ctx = c; })]);

  assert.deepEqual(ctx.speak('Police ahead', { key: 'a1' }), { spoken: true });
  assert.deepEqual(ctx.speak('Police ahead', { key: 'a1' }), { spoken: false, reason: 'duplicate' }, 'a keyed prompt is said once');
  assert.deepEqual(ctx.speak('Plain'), { spoken: true });
  assert.deepEqual(state.spoken, ['Police ahead', 'Plain']);

  state.voice = false;
  assert.deepEqual(ctx.speak('Muted', { key: 'a2' }), { spoken: false, reason: 'voice-off' });
  state.voice = true;
  assert.deepEqual(ctx.speak('Unmuted', { key: 'a2' }), { spoken: true }, 'a muted key is not recorded, so it can still be said');

  state.fix = fixAt(CAR[0], CAR[1], { t: Date.now() - 11_000 });
  assert.deepEqual(ctx.speak('Stale', { key: 'a3' }), { spoken: false, reason: 'stale' }, 'older than 10 s');
  state.fix = fixAt(CAR[0], CAR[1], { accuracy: 80 });
  assert.deepEqual(ctx.speak('Loose', { key: 'a3' }), { spoken: false, reason: 'inaccurate' }, 'worse than 75 m');
  state.fix = null;
  assert.deepEqual(ctx.speak('No fix'), { spoken: false, reason: 'no-fix' });
  state.fix = fixAt(CAR[0], CAR[1]);

  assert.throws(() => ctx.speak(''), /speak text/);
  runner.stopAll();
  assert.deepEqual(ctx.speak('Late'), { spoken: false, reason: 'stopped' }, 'a stopped source may not speak');
  let ctx2!: DriveSourceContext;
  runner.sync([item('talk', (c) => { ctx2 = c; })]);
  assert.deepEqual(ctx2.speak('Police ahead', { key: 'a1' }), { spoken: true }, 'a new drive says it again');
});

test('tuning sets the speech gate for one source; a source with none keeps the host rules', () => {
  const { state, env } = world();
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let lax!: DriveSourceContext;
  let strict!: DriveSourceContext;
  runner.sync([
    item('lax', (c) => { lax = c; }, { tuning: { ...DRIVE_TUNING_DEFAULTS, speakMaxAgeMs: 30_000, speakMaxAccuracyM: 100 } }),
    item('strict', (c) => { strict = c; }),
  ]);
  state.fix = fixAt(CAR[0], CAR[1], { t: Date.now() - 11_000, accuracy: 80 });
  assert.deepEqual(lax.speak('Lax'), { spoken: true });
  assert.deepEqual(strict.speak('Strict'), { spoken: false, reason: 'stale' });
  state.fix = fixAt(CAR[0], CAR[1], { accuracy: 120 });
  assert.deepEqual(lax.speak('Loose'), { spoken: false, reason: 'inaccurate' });
  state.fix = fixAt(CAR[0], CAR[1], { t: Date.now() - 40_000 });
  assert.deepEqual(lax.speak('Old'), { spoken: false, reason: 'stale' });
  assert.deepEqual(state.spoken, ['Lax']);
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

test('images: a source adds one under its scopedId, replaces it by name, removes it by name, and loses the rest when it stops', () => {
  const { env } = world();
  const map = new FakeDriveMap();
  const runner = new DriveRunner(asMap(map), env);
  let ctx!: DriveSourceContext;
  const a = { width: 1, height: 1, data: new Uint8Array(4) } as unknown as DriveImage;
  const b = { width: 2, height: 2, data: new Uint8Array(16) } as unknown as DriveImage;
  runner.sync([
    item('img', (c) => { ctx = c; assert.equal(c.addImage('pin', a), 'pl:img:pin'); }),
    item('other', (c) => { c.addImage('pin', a); }),
  ]);
  assert.deepEqual([...map.images.keys()].sort(), ['pl:img:pin', 'pl:other:pin']);

  assert.equal(ctx.addImage('pin', b), 'pl:img:pin', 'the same name gives the same id');
  assert.equal(map.images.get('pl:img:pin'), b, 'and replaces the image');
  assert.deepEqual(map.imageErrors, [], 'a replacement is not a duplicate add');

  ctx.removeImage('pin');
  assert.deepEqual([...map.images.keys()], ['pl:other:pin'], 'removed by name; the other source keeps its own');
  ctx.removeImage('pin');
  assert.deepEqual(map.imageErrors, [], 'removing a removed name is quiet');

  ctx.addImage('kept', b);
  runner.stopAll();
  assert.deepEqual([...map.images.keys()], [], 'closing the Drive screen takes every image off');
  assert.deepEqual(map.imageErrors, []);
  assert.throws(() => ctx.addImage('', a), /scopedId name/);
});

test('showPopup: a popup on the Drive map, one per source; the next one closes the last; the source stopping closes it', () => {
  const { state, env } = world();
  const map = new FakeDriveMap();
  const runner = new DriveRunner(asMap(map), env);
  let ctx!: DriveSourceContext;
  runner.sync([item('pop', (c) => { ctx = c; })]);

  const first = ctx.showPopup([151.2, -33.87], 'Hello');
  const p1 = state.popups[0];
  assert.deepEqual(p1.at, [151.2, -33.87]);
  assert.equal(p1.text, 'Hello', 'a string is shown as text');
  assert.equal(p1.added, asMap(map), 'the popup belongs to the Drive map');

  const el = { tag: 'div' } as unknown as HTMLElement;
  ctx.showPopup([151.3, -33.87], el);
  const p2 = state.popups[1];
  assert.equal(p1.removed, 1, 'showing another popup closes the first');
  assert.equal(p2.dom, el, 'an element is shown as the content');
  assert.equal(p2.text, null);

  const second = ctx.showPopup([151.25, -33.87], 'Again');
  assert.equal(p2.removed, 1, 'and so on, one at a time');
  second.close();
  assert.equal(state.popups[2].removed, 1, 'the close handle closes it');
  first.close();

  ctx.showPopup([151.22, -33.87], 'Left open');
  const open = state.popups[3];
  runner.stopAll();
  assert.equal(open.removed, 1, 'the source stopping closes its popup');

  assert.throws(() => ctx.showPopup([Number.NaN, 0], 'x'), /showPopup needs/);
  assert.throws(() => ctx.showPopup([151.2, -33.87], 42 as never), /string or an element/);
});

test('routeAhead, fix and speak keep the same answers after a source stops (no throw, no stale state)', () => {
  const { state, env } = world();
  state.route = ROUTE;
  const runner = new DriveRunner(asMap(new FakeDriveMap()), env);
  let ctx!: DriveSourceContext;
  runner.sync([item('late', (c) => { ctx = c; })]);
  runner.stopAll();
  assert.deepEqual(ctx.fix()?.point, CAR, 'the fix is the screen\'s, still readable');
  assert.equal(typeof ctx.routeAhead([151.21, -33.87]), 'number');
  assert.deepEqual(ctx.speak('after'), { spoken: false, reason: 'stopped' });
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
