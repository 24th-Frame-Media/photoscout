import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Map as MapLibreMap, Popup } from 'maplibre-gl';
import { activitySnapshot, clearActivity } from '../src/activity.js';
import { definePlugin, type LegendEntry, type PluginHttpError, type SettingsTabProps } from '../src/plugins/api.js';
import { isBundlePath, loadWebPlugins, parseEntries } from '../src/plugins/loader.js';
import { createPoll } from '../src/plugins/poll.js';
import { PluginView, legendCategory } from '../src/plugins/react.js';
import { PluginRegistry, pluginRoute, type MapAttachment } from '../src/plugins/registry.js';
import { nearestAlert } from '../src/plugins/nearestAlert.js';
import { groupsWith, isPluginTabHash, tabFromHash } from '../src/settings/tabs.js';
import example from './fixtures/example-plugin/web.js';

const ID = 'test.example.places';
const URL_ = `/plugins/${ID}/1.0.0/web.js`;
const entry = { id: ID, version: '1.0.0', name: 'Example', web: URL_ };

// --- fakes ---------------------------------------------------------------------

type Handler = (e: unknown) => void;

/** Just enough of maplibre's Map for the host: layers, sources, listeners, a feature query. */
class FakeMap {
  layers = new Map<string, { id: string; layout: Record<string, unknown> }>();
  sources = new Map<string, { data: unknown }>();
  handlers = new Map<string, Set<Handler>>();
  hits: { layer: { id: string }; properties: Record<string, unknown> }[] = [];
  addSource(id: string, spec: { data?: unknown }) {
    if (this.sources.has(id)) throw new Error(`Source "${id}" already exists.`);
    this.sources.set(id, { data: spec.data });
  }
  getSource(id: string) {
    const s = this.sources.get(id);
    return s && { setData: (d: unknown) => { s.data = d; } };
  }
  addLayer(spec: { id: string; layout?: Record<string, unknown> }) {
    if (this.layers.has(spec.id)) throw new Error(`Layer "${spec.id}" already exists.`);
    this.layers.set(spec.id, { id: spec.id, layout: { ...spec.layout } });
  }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  removeSource(id: string) { this.sources.delete(id); }
  setLayoutProperty(id: string, prop: string, value: unknown) { this.layers.get(id)!.layout[prop] = value; }
  getStyle() { return { layers: [...this.layers.values()], sources: Object.fromEntries(this.sources) }; }
  getBounds() { return { getWest: () => 149, getEast: () => 150, getSouth: () => -34, getNorth: () => -33 }; }
  queryRenderedFeatures(_p: unknown, opts: { layers: string[] }) { return this.hits.filter((h) => opts.layers.includes(h.layer.id)); }
  on(type: string, fn: Handler) { (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!).add(fn); }
  off(type: string, fn: Handler) { this.handlers.get(type)?.delete(fn); }
  emit(type: string, e: unknown = {}) { for (const fn of [...(this.handlers.get(type) ?? [])]) fn(e); }
  visibility(id: string) { return this.layers.get(id)?.layout.visibility; }
}

const click = { point: { x: 10, y: 20 }, lngLat: { lng: 149.5, lat: -33.4 } };

function setup(options: { interactive?: () => boolean } = {}) {
  const requested: string[] = [];
  const registry = new PluginRegistry({
    storage: null,
    fetch: (async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ places: [{ id: 'p1', title: 'Hut', point: [149.5, -33.4] }] }), { status: 200 });
    }) as typeof fetch,
  });
  const map = new FakeMap();
  const popups: string[] = [];
  const attachment: MapAttachment = {
    map: map as unknown as MapLibreMap,
    isInteractive: options.interactive ?? (() => true),
    createPopup: () => {
      const popup = { setLngLat: () => popup, setText: () => popup, setDOMContent: () => popup, addTo: () => popup, remove: () => {} };
      popups.push('popup');
      return popup as unknown as Popup;
    },
  };
  return { registry, map, attachment, requested, popups };
}

/** The loader, fed an in-memory bundle instead of a network. */
const load = (registry: PluginRegistry, modules: Record<string, unknown>, entries: unknown[] = [entry]) =>
  loadWebPlugins({
    registry,
    fetchList: async () => new Response(JSON.stringify(entries), { status: 200 }),
    importModule: async (url) => {
      if (!(url in modules)) throw new Error('404');
      return modules[url];
    },
  });

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => mock.timers.reset());

// --- the proof: a bundle loads and everything it registered shows up ---------------

test('a bundle loads end to end: legend entry, layer, settings tab, panels and drive source all appear', async () => {
  const { registry, map, attachment, requested } = setup();
  const outcome = await load(registry, { [URL_]: { default: example } });
  assert.deepEqual(outcome, { kind: 'loaded', active: [ID], failed: [] });

  const snap = registry.getSnapshot();
  assert.equal(snap.phase, 'ready');
  assert.deepEqual(snap.plugins.map((p) => [p.id, p.state]), [[ID, 'active']]);

  // legend + settings + panels + drive land in the snapshot the UI renders, keyed by plugin id
  assert.deepEqual(snap.legend.map((l) => [l.globalKey, l.label, l.on, l.menu]), [[`${ID}:places`, 'Example places', false, 'live']]);
  assert.deepEqual(snap.settingsTabs.map((t) => [t.id, t.label, t.group, t.admin]), [[`${ID}:main`, 'Example', 'Map', true]]);
  assert.equal(typeof snap.settingsTabs[0].view.component, 'function', 'a React component view');
  assert.deepEqual(snap.cornerPanels.map((c) => [c.id, c.whileOn]), [[`${ID}:hint`, `${ID}:places`]]);
  assert.deepEqual(snap.sidePanels.map((p) => p.id), [`${ID}:detail`]);
  assert.deepEqual(snap.driveSources.map((d) => d.id), [`${ID}:places`]);

  // the map: onReady adds the scoped source and layer, hidden because the toggle is off
  registry.attachMap(attachment);
  assert.ok(map.sources.has(`${ID}:places`));
  assert.equal(map.visibility(`${ID}:points`), 'none');
  assert.deepEqual(requested, [], 'nothing is polled while the toggle is off');

  // turning it on shows the layer and starts polling the plugin's own routes
  registry.setLegendOn(`${ID}:places`, true);
  assert.equal(map.visibility(`${ID}:points`), 'visible');
  await tick();
  assert.equal(requested.length, 1);
  assert.match(requested[0], new RegExp(`^/api/plugins/${ID}/places\\?bbox=149,-34,150,-33$`));
  assert.equal((map.sources.get(`${ID}:places`)!.data as { features: unknown[] }).features.length, 1);
  assert.equal(registry.getSnapshot().legend[0].on, true);

  // and off again hides it, stops polling and clears the source
  registry.setLegendOn(`${ID}:places`, false);
  assert.equal(map.visibility(`${ID}:points`), 'none');
  assert.equal((map.sources.get(`${ID}:places`)!.data as { features: unknown[] }).features.length, 0);
});

test('a click on a plugin layer runs its handler; edit modes and empty map clicks behave', async () => {
  let interactive = true;
  const { registry, map, attachment, popups } = setup({ interactive: () => interactive });
  await load(registry, { [URL_]: { default: example } });
  registry.attachMap(attachment);
  map.hits = [{ layer: { id: `${ID}:points` }, properties: { id: 'p1', title: 'Hut' } }];

  interactive = false; // drawing a route: plugin clicks are ignored
  map.emit('click', click);
  assert.equal(registry.getSnapshot().openSidePanel, null);
  interactive = true;

  map.emit('click', click);
  assert.equal(registry.getSnapshot().openSidePanel?.label, 'Place details');
  assert.equal((registry.getSnapshot().openSidePanel?.data as { title: string }).title, 'Hut');
  assert.equal(popups.length, 1);

  map.hits = []; // a click on empty map dismisses the side panel
  map.emit('click', click);
  assert.equal(registry.getSnapshot().openSidePanel, null);
});

test('the settings tab built from host.ui.react renders through the host', async () => {
  const { registry } = setup();
  await load(registry, { [URL_]: { default: example } });
  const tab = registry.getSnapshot().settingsTabs[0];
  const html = renderToStaticMarkup(createElement(PluginView<SettingsTabProps>, { pluginId: tab.pluginId, view: tab.view, props: { isAdmin: true } }));
  assert.match(html, /Admin view/);
  assert.match(html, /Clicked 0/);
});

test('the toggle is remembered and the plugin default applies only until the person chooses', async () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
  const first = new PluginRegistry({ storage });
  await load(first, { [URL_]: { default: example } });
  assert.equal(first.legendOn(`${ID}:places`), false);
  first.setLegendOn(`${ID}:places`, true);
  const second = new PluginRegistry({ storage });
  await load(second, { [URL_]: { default: example } });
  assert.equal(second.legendOn(`${ID}:places`), true);
});

// --- failure and private-mode handling --------------------------------------------

test('one bad plugin does not stop the others, and is logged and recorded', async () => {
  clearActivity();
  const { registry } = setup();
  const quiet = console.error;
  console.error = () => {};
  try {
    const entries = ['good', 'nodefault', 'throws404', 'activatefails'].map((n) => ({ id: `test.${n}.x`, version: '1.0.0', name: n, web: `/plugins/test.${n}.x/1.0.0/web.js` }));
    const url = (n: string) => `/plugins/test.${n}.x/1.0.0/web.js`;
    const partial = definePlugin({
      activate(host) {
        host.legend.add({ key: 'half', label: 'Half', swatch: { kind: 'dot', color: '#fff' } });
        host.settings.addTab({ id: 'half', label: 'Half', render: () => {} });
        throw new Error('boom');
      },
    });
    const outcome = await load(registry, {
      [url('good')]: { default: example },
      [url('nodefault')]: { notDefault: 1 },
      [url('activatefails')]: { default: partial },
    }, entries);
    assert.deepEqual(outcome, { kind: 'loaded', active: ['test.good.x'], failed: ['test.nodefault.x', 'test.throws404.x', 'test.activatefails.x'] });

    const snap = registry.getSnapshot();
    assert.deepEqual(snap.plugins.map((p) => [p.name, p.state]), [['nodefault', 'failed'], ['throws404', 'failed'], ['activatefails', 'failed'], ['good', 'active']]);
    assert.equal(snap.plugins.find((p) => p.name === 'activatefails')?.error, 'boom');
    // the failed activate was rolled back: only the good plugin's contributions remain
    assert.deepEqual(snap.legend.map((l) => l.pluginId), ['test.good.x']);
    assert.deepEqual(snap.settingsTabs.map((t) => t.pluginId), ['test.good.x']);
    assert.ok(activitySnapshot().some((a) => a.service === 'Plugins' && a.level === 'error'));
  } finally {
    console.error = quiet;
  }
});

test('a throwing callback is contained and logged', async () => {
  clearActivity();
  const { registry, map, attachment } = setup();
  const quiet = console.error;
  console.error = () => {};
  try {
    await load(registry, {
      [URL_]: {
        default: definePlugin({
          activate(host) {
            host.map.onReady(() => { throw new Error('ready boom'); });
            host.map.onReady((m) => { m.addSource('after', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }); });
            const entry = host.legend.add({ key: 'a', label: 'A', swatch: { kind: 'dot', color: '#fff' } });
            entry.onChange(() => { throw new Error('change boom'); });
          },
        }),
      },
    });
    registry.attachMap(attachment);
    assert.ok(map.sources.has('after'), 'the next onReady still ran');
    assert.doesNotThrow(() => registry.setLegendOn(`${ID}:a`, true));
    assert.equal(registry.legendOn(`${ID}:a`), true);
    assert.ok(activitySnapshot().some((a) => a.service === 'Example' && a.level === 'error'));
  } finally {
    console.error = quiet;
  }
});

test('private mode: a 401 or 403 on the list is quiet, loads nothing, and can be retried', async () => {
  clearActivity();
  for (const status of [401, 403]) {
    const { registry } = setup();
    const outcome = await loadWebPlugins({ registry, fetchList: async () => new Response('{}', { status }), importModule: async () => { throw new Error('must not import'); } });
    assert.deepEqual(outcome, { kind: 'unavailable', reason: 'sign-in required' });
    assert.equal(registry.getSnapshot().phase, 'ready');
    assert.equal(registry.getSnapshot().plugins.length, 0);
  }
  const { registry } = setup();
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const outcome = await loadWebPlugins({ registry, fetchList: async () => { throw new TypeError('network down'); } });
    assert.equal(outcome.kind, 'unavailable');
  } finally {
    console.warn = quiet;
  }
  assert.equal(activitySnapshot().length, 0, 'a sign-in gate is not an error to show the person');
});

test('only same-origin, versioned bundle paths are imported, and malformed rows are skipped', () => {
  assert.equal(isBundlePath(ID, '1.0.0', `/plugins/${ID}/1.0.0/web.js`), true);
  assert.equal(isBundlePath(ID, '1.0.0', `/plugins/${ID}/1.0.0/dist/web.mjs`), true);
  for (const bad of [
    'https://evil.example/web.js', '//evil.example/web.js', `/plugins/${ID}/1.0.0/../2.0.0/web.js`, `/plugins/other.plugin.x/1.0.0/web.js`,
    `/plugins/${ID}/1.0.0/web.js?x=1`, `/plugins/${ID}/1.0.0/.hidden.js`, `/plugins/${ID}/1.0.0/web.css`, `/plugins/${ID}/1.0.0/`, `/plugins/${ID}/1.0.0/a\\b.js`,
  ]) assert.equal(isBundlePath(ID, '1.0.0', bad), false, bad);

  const skipped: string[] = [];
  const rows = parseEntries([entry, entry, { id: 'Bad Id', version: '1', web: '/x.js' }, { id: ID, version: '2', web: 'https://evil/x.js' }, null, 7], (why) => skipped.push(why));
  assert.deepEqual(rows.map((r) => r.id), [ID]);
  assert.equal(skipped.length, 5);
  assert.deepEqual(parseEntries({ not: 'an array' }), []);
});

// --- the API surface rejects misuse -------------------------------------------------

async function hostFor(registry: PluginRegistry, run: (host: Parameters<Parameters<typeof definePlugin>[0]['activate']>[0]) => void) {
  await registry.activate({ id: ID, name: 'Example', version: '1.0.0' }, definePlugin({ activate: run }));
}

test('ids, colours, groups and views are validated and namespaced', async () => {
  const registry = new PluginRegistry({ storage: null });
  await hostFor(registry, (host) => {
    const swatch = { kind: 'dot', color: '#fff' } as const;
    assert.throws(() => host.legend.add({ key: 'Bad Key', label: 'x', swatch }), /lowercase/);
    assert.throws(() => host.legend.add({ key: 'a', label: '', swatch }), /non-empty/);
    assert.throws(() => host.legend.add({ key: 'a', label: 'x', swatch: { kind: 'dot', color: 'url(https://evil/x.png)' } }), /colour/);
    assert.throws(() => host.legend.add({ key: 'a', label: 'x', swatch: { kind: 'nope' as 'dot', color: '#fff' } }), /swatch.kind/);
    host.legend.add({ key: 'a', label: 'A', swatch: { kind: 'dot', color: 'radial-gradient(circle, #ef4444 0%, #2563eb 100%)' } });
    assert.throws(() => host.legend.add({ key: 'a', label: 'A', swatch }), /already registered/);
    assert.throws(() => host.settings.addTab({ id: 't', label: 'T', group: 'Admin' as 'Map', render: () => {} }), /group/);
    assert.throws(() => host.settings.addTab({ id: 't', label: 'T', render: () => {}, component: () => null } as never), /exactly one/);
    assert.throws(() => host.panel.addCorner({ id: 'c', whileOn: 'Not Valid', render: () => {} }), /lowercase/);
    assert.equal(host.map.scopedId('x'), `${ID}:x`);
    assert.equal(host.assetUrl('icon.png'), `/plugins/${ID}/1.0.0/assets/icon.png`);
    assert.throws(() => host.assetUrl('../server.js'), /relative/);
  });
  assert.equal(registry.getSnapshot().legend.length, 1);
});

test('data routes cannot leave the plugin: no traversal, no protocol-relative URL, no other origin', () => {
  assert.equal(pluginRoute(ID, '/places?x=1'), `/api/plugins/${ID}/places?x=1`);
  assert.equal(pluginRoute(ID, '/'), `/api/plugins/${ID}/`);
  for (const bad of ['places', '//evil.example/x', '/../auth/status', '/a/../b', '/a/%2e%2e/b', '/a/%2E%2E', '/./x', '/a\\b', 'https://evil.example', '/x#frag', '/x\n', '/%zz', '']) {
    assert.throws(() => pluginRoute(ID, bad), /plugin route/, JSON.stringify(bad));
  }
});

test('data.json turns a non-2xx answer into an error carrying the status and the server message', async () => {
  const registry = new PluginRegistry({
    storage: null,
    fetch: (async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })) as typeof fetch,
  });
  await hostFor(registry, (host) => {
    void host.data.json('/places').then(
      () => assert.fail('should reject'),
      (err: PluginHttpError) => { assert.equal(err.status, 404); assert.equal(err.message, 'Not found'); },
    );
  });
  await tick();
});

test('disposing a plugin removes its contributions, its polls and its layers from the live map', async () => {
  const { registry, map, attachment } = setup();
  await load(registry, { [URL_]: { default: example } });
  registry.attachMap(attachment);
  assert.ok(map.layers.has(`${ID}:points`));
  registry.dispose(ID);
  const snap = registry.getSnapshot();
  assert.equal(snap.legend.length + snap.settingsTabs.length + snap.cornerPanels.length + snap.sidePanels.length + snap.driveSources.length, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
});

test('attaching the same map again (StrictMode, a remount) runs onReady afresh without "already exists"', async () => {
  const { registry, map, attachment } = setup();
  await load(registry, { [URL_]: { default: example } });
  const detach = registry.attachMap(attachment);
  registry.setLegendOn(`${ID}:places`, true);
  detach();
  assert.equal(map.layers.size, 0, 'the plugin layers went with the detach');
  assert.equal(map.handlers.get('click')?.size, 0, 'and the click router');
  registry.attachMap(attachment);
  assert.equal(map.visibility(`${ID}:points`), 'visible', 'the remembered toggle is applied to the new layers');
  registry.dispose(ID); // stops the poll the toggle started
});

test('a plugin that activates after the map is ready still gets onReady', async () => {
  const { registry, map, attachment } = setup();
  registry.attachMap(attachment);
  await load(registry, { [URL_]: { default: example } });
  assert.ok(map.layers.has(`${ID}:points`));
});

// --- pieces ---------------------------------------------------------------------------

test('plugin settings tabs join the menu groups, and their hashes resolve once the tab exists', () => {
  const tab = { id: `${ID}:main`, label: 'Example', group: 'Map' as const, admin: true };
  const own = { id: `${ID}:other`, label: 'Other', group: 'Plugins' as const, admin: false };
  const groups = groupsWith([tab, own]);
  assert.deepEqual(groups.map((g) => g.label), ['You', 'Map', 'Events', 'Busy places', 'Plugins', 'Admin']);
  assert.deepEqual(groups[1].tabs.map((t) => t.id), ['areas', 'feeds', 'waze', `${ID}:main`]);
  assert.deepEqual(groups[4].tabs, [{ id: `${ID}:other`, label: 'Other', admin: false }]);

  assert.equal(tabFromHash(`#${ID}:main`), 'areas', 'unknown until the plugin has loaded');
  assert.equal(tabFromHash(`#${ID}:main`, [`${ID}:main`]), `${ID}:main`);
  assert.equal(isPluginTabHash(`#${ID}:main`), true);
  assert.equal(isPluginTabHash('#crawler'), false);
});

test('a legend entry becomes a core Category, so the Legend and menus draw it unchanged', () => {
  const cat = legendCategory({ globalKey: `${ID}:places`, pluginId: ID, key: 'places', label: 'P', swatch: { kind: 'glyph', color: '#10b981', glyph: '📻' }, menu: 'live', defaultOn: true, on: false });
  assert.deepEqual([cat.key, cat.label, cat.group, cat.swatch, cat.glyph, cat.color, cat.defaultOn], [`${ID}:places`, 'P', 'Overlays', 'glyph', '📻', '#10b981', true]);
  assert.equal(cat.match({ id: 'anything', type: 'circle' }), false);
});

test('drive: the nearest alert within range wins', () => {
  const here: [number, number] = [149.5, -33.4];
  const near = { id: 'a', point: [149.5005, -33.4] as [number, number], title: 'Near' };
  const far = { id: 'b', point: [149.52, -33.4] as [number, number], title: 'Far' };
  assert.equal(nearestAlert({ x: [far, near] }, here)?.alert.id, 'a');
  assert.equal(nearestAlert({ x: [far] }, here), null);
  assert.equal(nearestAlert({ x: [near] }, null), null);
});

test('poll: immediate first request, then the interval, never faster than the gap, and stops when asked', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const seen: number[] = [];
  let stopped = 0;
  const poll = createPoll<number>({
    intervalMs: 30_000,
    fetch: async () => seen.length + 1,
    onData: (n) => { seen.push(n); },
    onStop: () => { stopped++; },
  }, (err) => assert.fail(String(err)));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(seen, [1], 'the first poll is immediate');

  poll.refresh(); // inside the 5 s gap: deferred, not dropped
  await Promise.resolve();
  assert.deepEqual(seen, [1]);
  mock.timers.tick(5_000);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(seen, [1, 2]);

  mock.timers.tick(30_000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(seen.length, 3, 'the interval polls again');

  poll.stop();
  assert.equal(stopped, 1);
  mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(seen.length, 3, 'no polling after stop');
});

test('poll: gated by a legend entry, retryAfterMs shortens the wait, turning off stops the polling', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let on = false;
  const listeners = new Set<(on: boolean) => void>();
  const gate = {
    key: 'k', get on() { return on; }, setOn() {}, toggle() {}, syncLayers() {},
    onChange: (cb: (on: boolean) => void) => { listeners.add(cb); return () => void listeners.delete(cb); },
  } satisfies LegendEntry;
  let calls = 0;
  const got: string[] = [];
  createPoll<string>({
    while: gate,
    fetch: async () => `r${++calls}`,
    onData: (d) => { got.push(d); },
    retryAfterMs: (d) => (d === 'r1' ? 6_000 : null),
  }, (err) => assert.fail(String(err)));
  assert.equal(calls, 0, 'off: nothing runs');
  on = true; listeners.forEach((l) => l(true));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(got, ['r1']);
  mock.timers.tick(6_000);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(got, ['r1', 'r2'], 'retryAfterMs polled again well before the 30 s interval');
  on = false; listeners.forEach((l) => l(false));
  mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(calls, 2);
});

