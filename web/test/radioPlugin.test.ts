import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSync } from 'esbuild';
import type { Map as MapLibreMap, Popup } from 'maplibre-gl';
import type { SidePanelProps } from '../src/plugins/api.js';
import { loadWebPlugins } from '../src/plugins/loader.js';
import { PluginView } from '../src/plugins/react.js';
import { PluginRegistry, type MapAttachment } from '../src/plugins/registry.js';
import { CATEGORIES } from '../src/map/legend.js';
import { createStationsContent, type StationsContentProps } from '../../plugins/radio-garden/src/web/view.js';
import type { RadioPlace, RadioStation } from '../../plugins/radio-garden/src/web/types.js';

/**
 * The radio-garden plugin's web bundle, built from its source exactly as
 * plugins/radio-garden/build.mjs builds it, loaded through the real loader and
 * registry. This is the proof that the radio feature that used to be hardcoded in
 * the app (layers.ts, MapPage.tsx, RadioPanel) works through the plugin API alone.
 */

const ID = 'media.24thframe.radio-garden';
const WEB_URL = `/plugins/${ID}/1.0.0/web.js`;
const entry = { id: ID, version: '1.0.0', name: 'Radio Garden', web: WEB_URL };
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'radio-garden');
const SRC = `${ID}:src`, CLUSTERS = `${ID}:clusters`, COUNT = `${ID}:cluster-count`, POINTS = `${ID}:points`;

function buildBundle(): string {
  const out = buildSync({
    entryPoints: [path.join(PLUGIN_DIR, 'src', 'web.ts')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: [], logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

let moduleCache: Promise<unknown> | null = null;
function bundleModule(): Promise<unknown> {
  moduleCache ??= import(`data:text/javascript;base64,${Buffer.from(buildBundle()).toString('base64')}`);
  return moduleCache;
}

// --- fakes ---------------------------------------------------------------------

type Handler = (e: unknown) => void;
interface LayerSpec { id: string; type: string; source: string; filter?: unknown; layout?: Record<string, unknown>; paint?: Record<string, unknown> }
interface SourceSpec { type: string; data: { features: unknown[] }; cluster?: boolean; clusterMaxZoom?: number; clusterRadius?: number; attribution?: string }

class FakeMap {
  layers = new Map<string, LayerSpec>();
  sources = new Map<string, SourceSpec>();
  handlers = new Map<string, Set<Handler>>();
  hits: { layer: { id: string }; properties: Record<string, unknown>; geometry: { type: 'Point'; coordinates: [number, number] } }[] = [];
  expansionAsked: number[] = [];
  eased: { center: [number, number]; zoom: number }[] = [];
  addSource(id: string, spec: SourceSpec) { this.sources.set(id, spec); }
  getSource(id: string) {
    const s = this.sources.get(id);
    return s && {
      setData: (d: SourceSpec['data']) => { s.data = d; },
      getClusterExpansionZoom: async (clusterId: number) => { this.expansionAsked.push(clusterId); return 7; },
    };
  }
  addLayer(spec: LayerSpec) { this.layers.set(spec.id, { ...spec, layout: { ...spec.layout } }); }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  removeSource(id: string) { this.sources.delete(id); }
  setLayoutProperty(id: string, prop: string, value: unknown) { this.layers.get(id)!.layout![prop] = value; }
  getStyle() { return { layers: [...this.layers.values()], sources: Object.fromEntries(this.sources) }; }
  queryRenderedFeatures(_p: unknown, opts: { layers: string[] }) { return this.hits.filter((h) => opts.layers.includes(h.layer.id)); }
  easeTo(o: { center: [number, number]; zoom: number }) { this.eased.push(o); }
  on(type: string, fn: Handler) { (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!).add(fn); }
  off(type: string, fn: Handler) { this.handlers.get(type)?.delete(fn); }
  emit(type: string, e: unknown = {}) { for (const fn of [...(this.handlers.get(type) ?? [])]) fn(e); }
  visibility(id: string) { return this.layers.get(id)?.layout?.visibility; }
}

const click = { point: { x: 10, y: 20 }, lngLat: { lng: 151.2, lat: -33.9 } };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const places: RadioPlace[] = [
  { id: 'syd', title: 'Sydney', country: 'Australia', lng: 151.2093, lat: -33.8688, stationCount: 42 },
  { id: 'nyc', title: 'New York NY', country: 'United States', lng: -74.006, lat: 40.7128, stationCount: 1 },
];
const stations: RadioStation[] = [
  { id: 'fbi', title: 'FBi Radio', placeId: 'syd', streamDomain: 'fbi.example', listenUrl: `/api/plugins/${ID}/stations/fbi/listen` },
  { id: 'triple-j', title: 'Triple J', placeId: 'syd', listenUrl: `/api/plugins/${ID}/stations/triple-j/listen` },
];

class FakeAudio {
  static made: FakeAudio[] = [];
  src = '';
  paused = true;
  onplaying: ((ev: Event) => void) | null = null;
  onwaiting: ((ev: Event) => void) | null = null;
  onpause: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onended: ((ev: Event) => void) | null = null;
  constructor() { FakeAudio.made.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

interface PlayerHook { handleStationClick(s: RadioStation): void; getState(): { playbackState: string; activeStation: RadioStation | null } }
const player = () => (globalThis as { __photoscoutRadioPlayer?: PlayerHook }).__photoscoutRadioPlayer!;

async function setup() {
  const requested: string[] = [];
  const registry = new PluginRegistry({
    storage: null,
    fetch: (async (url: string) => {
      requested.push(String(url));
      if (String(url).endsWith('/places')) return new Response(JSON.stringify({ places }), { status: 200 });
      if (String(url).includes('/places/syd/stations')) return new Response(JSON.stringify({ placeId: 'syd', stations }), { status: 200 });
      return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
    }) as typeof fetch,
  });
  const map = new FakeMap();
  const attachment: MapAttachment = {
    map: map as unknown as MapLibreMap,
    isInteractive: () => true,
    createPopup: () => { const p = { setLngLat: () => p, setText: () => p, setDOMContent: () => p, addTo: () => p, remove: () => {} }; return p as unknown as Popup; },
  };
  const outcome = await loadWebPlugins({
    registry,
    fetchList: async () => new Response(JSON.stringify([entry]), { status: 200 }),
    importModule: async (url) => { assert.equal(url, WEB_URL); return bundleModule(); },
  });
  return { registry, map, attachment, requested, outcome };
}

const globals = globalThis as { Audio?: unknown };
const realAudio = globals.Audio;
afterEach(() => {
  globals.Audio = realAudio;
  FakeAudio.made = [];
});

// --- the bundle itself -----------------------------------------------------------

test('the built bundle is a browser ES module that imports nothing and bundles no React', () => {
  const code = buildBundle();
  assert.doesNotMatch(code, /^\s*import\s/m, 'no static imports');
  assert.doesNotMatch(code, /\bimport\(/, 'no dynamic imports');
  assert.doesNotMatch(code, /react\.production|__SECRET_INTERNALS|react-dom/, 'no copy of React');
  assert.match(code, /export\s*\{[^}]*as default/, 'default export');
});

test('the core app no longer hardcodes the radio feature', () => {
  assert.equal(CATEGORIES.some((c) => c.key === 'radio'), false, 'the radio legend category is gone from core');
});

// --- the feature, through the plugin API ------------------------------------------

test('the bundle loads and registers the toggle, the stations panel and the player widget', async () => {
  const { registry, outcome } = await setup();
  assert.deepEqual(outcome, { kind: 'loaded', active: [ID], failed: [] });
  const snap = registry.getSnapshot();

  assert.deepEqual(snap.legend.map((l) => ({ globalKey: l.globalKey, label: l.label, title: l.title, swatch: l.swatch, menu: l.menu, defaultOn: l.defaultOn, on: l.on })), [{
    globalKey: `${ID}:radio`, label: 'Radio', title: 'World radio locations (Radio Garden)',
    swatch: { kind: 'glyph', color: '#10b981', glyph: '📻' }, menu: 'live', defaultOn: false, on: false,
  }]);
  assert.deepEqual(snap.sidePanels.map((p) => [p.id, p.label]), [[`${ID}:stations`, 'Radio stations']]);
  assert.deepEqual(snap.cornerPanels.map((c) => [c.id, c.whileOn]), [[`${ID}:player`, null]], 'the player is not tied to the toggle');
});

test('the map: clustered source and the three layers, hidden until the toggle is on; stations fetched once', async () => {
  const { registry, map, attachment, requested } = await setup();
  registry.attachMap(attachment);

  const source = map.sources.get(SRC)!;
  assert.equal(source.cluster, true);
  assert.equal(source.clusterMaxZoom, 12);
  assert.equal(source.clusterRadius, 40);
  assert.match(source.attribution ?? '', /Radio Garden/);

  assert.deepEqual([...map.layers.keys()], [CLUSTERS, COUNT, POINTS]);
  assert.deepEqual(map.layers.get(CLUSTERS)!.filter, ['has', 'point_count']);
  assert.deepEqual(map.layers.get(CLUSTERS)!.paint, { 'circle-radius': 15, 'circle-color': '#0d2818', 'circle-stroke-color': '#10b981', 'circle-stroke-width': 2 });
  assert.deepEqual(map.layers.get(COUNT)!.paint, { 'text-color': '#10b981' });
  assert.equal(map.layers.get(COUNT)!.layout!['text-field'] instanceof Array, true);
  assert.deepEqual(map.layers.get(POINTS)!.filter, ['!', ['has', 'point_count']]);
  assert.deepEqual(map.layers.get(POINTS)!.paint, { 'circle-radius': 6, 'circle-color': '#10b981', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1.5 });
  for (const id of [CLUSTERS, COUNT, POINTS]) assert.equal(map.visibility(id), 'none', `${id} hidden while off`);
  assert.deepEqual(requested, [], 'nothing is fetched while the toggle is off');

  registry.setLegendOn(`${ID}:radio`, true);
  for (const id of [CLUSTERS, COUNT, POINTS]) assert.equal(map.visibility(id), 'visible', `${id} shown while on`);
  await tick();
  assert.deepEqual(requested, [`/api/plugins/${ID}/places`]);
  const features = map.sources.get(SRC)!.data.features as { id: string; geometry: { coordinates: number[] }; properties: Record<string, unknown> }[];
  assert.equal(features.length, 2);
  assert.equal(features[0].id, 'syd');
  assert.deepEqual(features[0].geometry.coordinates, [151.2093, -33.8688], '[lng, lat] order');
  assert.deepEqual(features[0].properties, { id: 'syd', title: 'Sydney', country: 'Australia', stationCount: 42 });

  // off hides the markers; on again does not fetch a second time (no polling)
  registry.setLegendOn(`${ID}:radio`, false);
  for (const id of [CLUSTERS, COUNT, POINTS]) assert.equal(map.visibility(id), 'none');
  registry.setLegendOn(`${ID}:radio`, true);
  await tick();
  assert.equal(requested.length, 1);
});

test('a cluster click zooms in; a marker click opens the stations panel; empty map closes it', async () => {
  const { registry, map, attachment } = await setup();
  registry.attachMap(attachment);
  registry.setLegendOn(`${ID}:radio`, true);
  await tick();

  map.hits = [{ layer: { id: CLUSTERS }, properties: { cluster_id: 77, point_count: 5 }, geometry: { type: 'Point', coordinates: [150, -34] } }];
  map.emit('click', click);
  await tick();
  assert.deepEqual(map.expansionAsked, [77]);
  assert.deepEqual(map.eased, [{ center: [150, -34], zoom: 7 }]);
  assert.equal(registry.getSnapshot().openSidePanel, null, 'a cluster opens no panel');

  map.hits = [{ layer: { id: POINTS }, properties: { id: 'syd', title: 'Sydney', country: 'Australia', stationCount: 42 }, geometry: { type: 'Point', coordinates: [151.2093, -33.8688] } }];
  map.emit('click', click);
  const open = registry.getSnapshot().openSidePanel!;
  assert.equal(open.label, 'Radio stations');
  assert.deepEqual(open.data, { id: 'syd', title: 'Sydney', country: 'Australia', lng: 151.2093, lat: -33.8688, stationCount: 42 });

  // the panel content (the host draws the frame around it)
  const html = renderToStaticMarkup(createElement(PluginView<SidePanelProps<unknown>>, { pluginId: ID, view: open.view, props: { data: open.data, close: () => {}, size: 'half' as const, toggleSize: () => {} } }));
  assert.match(html, /radiopanel/);
  assert.match(html, /📻 Sydney/);
  assert.match(html, /Australia · 42 stations/);
  assert.match(html, /Loading stations for Sydney/);
  assert.doesNotMatch(html, /panel__close|panel__handle/, 'the host owns the frame, not the content');

  map.hits = [];
  map.emit('click', click);
  assert.equal(registry.getSnapshot().openSidePanel, null);

  // turning the toggle off closes an open panel
  map.hits = [{ layer: { id: POINTS }, properties: { id: 'syd', title: 'Sydney' }, geometry: { type: 'Point', coordinates: [151.2, -33.9] } }];
  map.emit('click', click);
  assert.ok(registry.getSnapshot().openSidePanel);
  registry.setLegendOn(`${ID}:radio`, false);
  assert.equal(registry.getSnapshot().openSidePanel, null);
});

test('the stations content: list, active and paused states, empty and error', () => {
  const Content = createStationsContent({ createElement } as never);
  const base: StationsContentProps = { place: places[0], stations, loading: false, error: null, player: { activeStation: null, playbackState: 'idle', playbackError: null }, onStation() {}, onStop() {}, onRetry() {} };
  const html = (over: Partial<StationsContentProps> = {}) => renderToStaticMarkup(createElement(Content, { ...base, ...over }));

  const idle = html();
  assert.match(idle, /Play FBi Radio/);
  assert.match(idle, /fbi\.example/);
  assert.match(idle, /▶ Play/);
  assert.doesNotMatch(idle, /radiopanel__player-card/, 'no player card without a station');

  const playing = html({ player: { activeStation: stations[0], playbackState: 'playing', playbackError: null } });
  assert.match(playing, /radiopanel__player-card/);
  assert.match(playing, /🔊 Playing/);
  assert.match(playing, /aria-label="Pause FBi Radio"/);
  assert.match(playing, /is-active/);

  const failed = html({ player: { activeStation: stations[1], playbackState: 'error', playbackError: 'Stream unavailable.' } });
  assert.match(failed, /⚠️ Stream error/);
  assert.match(failed, /Stream unavailable\./);
  assert.match(failed, /↻ Retry/);

  assert.match(html({ stations: [] }), /No online stations listed for this location\./);
  assert.match(html({ stations: [], error: 'boom' }), /boom[\s\S]*↻ Retry/);
  assert.match(html({ place: places[1] }), /United States · 1 station</);
});

test('audio: a station plays through the bundle; the widget follows; the toggle and panel do not stop it; leaving the map does', async () => {
  globals.Audio = FakeAudio;
  const { registry, map, attachment } = await setup();
  const detach = registry.attachMap(attachment);
  registry.setLegendOn(`${ID}:radio`, true);
  await tick();

  const widget = () => {
    const c = registry.getSnapshot().cornerPanels[0];
    return renderToStaticMarkup(createElement(PluginView<Record<string, never>>, { pluginId: ID, view: c.view, props: {} }));
  };
  assert.doesNotMatch(widget(), /radiowidget/, 'idle: the widget draws nothing');

  // no autoplay: nothing exists until the person presses play
  assert.equal(FakeAudio.made.length, 0);
  player().handleStationClick(stations[0]);
  assert.equal(FakeAudio.made.length, 1);
  const audio = FakeAudio.made[0];
  assert.equal(audio.src, stations[0].listenUrl);
  assert.equal(audio.paused, false);
  assert.match(widget(), /⌛ Connecting/);
  audio.onplaying!(new Event('playing'));
  assert.match(widget(), /🔊 Playing/);
  assert.match(widget(), /FBi Radio/);

  // the layer going off, or the panel closing, leaves the audio and the widget alone
  registry.setLegendOn(`${ID}:radio`, false);
  registry.closeSidePanels();
  assert.equal(audio.paused, false);
  assert.match(widget(), /radiowidget/);

  // a second station replaces the first stream
  player().handleStationClick(stations[1]);
  assert.equal(FakeAudio.made.length, 2);
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');

  // leaving the map page stops playback, as unmounting the page did before
  const second = FakeAudio.made[1];
  detach();
  assert.equal(second.paused, true);
  assert.equal(player().getState().activeStation, null);
  assert.doesNotMatch(widget(), /radiowidget/);
  void map;
});

test('disposing the plugin removes its layers and the debug hook', async () => {
  const { registry, map, attachment } = await setup();
  registry.attachMap(attachment);
  assert.equal(map.layers.size, 3);
  registry.dispose(ID);
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(player(), undefined);
});
