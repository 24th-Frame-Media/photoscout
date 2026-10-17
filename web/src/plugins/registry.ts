import * as React from 'react';
import type { Map as MapLibreMap, MapMouseEvent, Popup } from 'maplibre-gl';
import { logActivity, type ActivityLevel } from '../activity.js';
import {
  WEB_API_VERSION,
  type DriveAlertFilter,
  type DriveAlertSourceDef,
  type LegendEntry,
  type LegendEntryDef,
  type LegendSwatch,
  type LngLat,
  type PluginHost,
  type PluginHttpError,
  type PluginMapClick,
  type PluginUser,
  type PollHandle,
  type PopupHandle,
  type SettingsGroup,
  type SettingsTabProps,
  type SidePanelDef,
  type SidePanelHandle,
  type SidePanelProps,
  type ViewSpec,
  type WebPlugin,
} from './api.js';
import { createPoll } from './poll.js';
import { DRIVE_TUNING_DEFAULTS, DRIVE_TUNING_LIMITS, type ResolvedDriveTuning } from './driveTuning.js';

/**
 * The host side of the web plugin API: owns every contribution, binds them to
 * the live app, and publishes an immutable snapshot the React layer renders.
 *
 * One `PluginRegistry` lives for the whole page (the `pluginRegistry` singleton
 * at the bottom). It is plain TypeScript with no DOM requirement at import time,
 * so it is unit-tested in Node against a fake map.
 */

const ACTIVATE_TIMEOUT_MS = 10_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR_RE = /^[#a-zA-Z0-9(),.%\s-]{1,200}$/;
const SWATCH_KINDS: ReadonlySet<string> = new Set(['dot', 'line', 'dashed', 'fill', 'ring', 'glyph', 'text']);
const SETTINGS_GROUPS: ReadonlySet<string> = new Set(['Map', 'Events', 'Plugins']);
const VISIBILITY_KEY = 'ls.plugins.legend';

/** Thrown to a plugin that misuses the API (bad id, duplicate key, use after disposal). */
export class PluginApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginApiError';
  }
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
}

// --- what the React layer reads -----------------------------------------------

export interface LegendItem {
  /** `<pluginId>:<key>`: the key the Legend, the toolbar and the saved choice use. */
  globalKey: string;
  pluginId: string;
  key: string;
  label: string;
  title?: string;
  swatch: LegendSwatch;
  menu: 'live' | 'scout';
  defaultOn: boolean;
  on: boolean;
}

export interface SettingsTabItem {
  /** `<pluginId>:<id>`: also the URL hash of the tab. */
  id: string;
  pluginId: string;
  label: string;
  group: SettingsGroup;
  admin: boolean;
  view: ViewSpec<SettingsTabProps>;
}

export interface CornerPanelItem {
  id: string;
  pluginId: string;
  /** Global legend key that gates the widget, or null. */
  whileOn: string | null;
  view: ViewSpec<Record<string, never>>;
}

export interface SidePanelItem {
  id: string;
  pluginId: string;
  label: string;
  open: boolean;
  data: unknown;
  view: ViewSpec<SidePanelProps<unknown>>;
}

export interface DriveSourceItem {
  /** `<pluginId>:<key>`: the key the Drive button and the host use. */
  id: string;
  pluginId: string;
  label: string;
  title?: string;
  /** The Drive button's state: whether the driver has the source on right now. */
  on: boolean;
  filter: DriveAlertFilter;
  runs: 'drive' | 'always';
  /** The source's tuning, every option resolved to a value (the host's rule where it set none). */
  tuning: ResolvedDriveTuning;
  start: DriveAlertSourceDef['start'];
}

export interface PluginRecord extends PluginInfo {
  state: 'active' | 'failed';
  error?: string;
}

export interface RegistrySnapshot {
  /** idle: nothing asked yet. loading: the list or a bundle is in flight. ready: every bundle has loaded or failed. */
  phase: 'idle' | 'loading' | 'ready';
  plugins: readonly PluginRecord[];
  legend: readonly LegendItem[];
  settingsTabs: readonly SettingsTabItem[];
  cornerPanels: readonly CornerPanelItem[];
  sidePanels: readonly SidePanelItem[];
  /** The side panel that is open, if any. */
  openSidePanel: SidePanelItem | null;
  driveSources: readonly DriveSourceItem[];
}

/** What the map page hands over when its map is ready. */
export interface MapAttachment {
  map: MapLibreMap;
  /** False while the map is in an editing mode (drawing a route, picking a spot): plugin clicks are ignored. */
  isInteractive(): boolean;
  /** maplibre's `Popup`, injected so this module never imports maplibre at runtime. */
  createPopup(): Popup;
}

export interface RegistryOptions {
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: `localStorage`, when there is one. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

// --- per-plugin bookkeeping ---------------------------------------------------

interface LegendRec {
  item: Omit<LegendItem, 'on'>;
  layers: string[];
  listeners: Set<(on: boolean) => void>;
}
interface SideRec {
  item: Omit<SidePanelItem, 'open' | 'data'>;
  open: boolean;
  data: unknown;
}
interface ReadyReg {
  cb: (map: MapLibreMap) => void | (() => void);
}
interface ClickReg {
  layers: readonly string[];
  cb: (e: PluginMapClick) => void;
}
interface DriveRec {
  item: Omit<DriveSourceItem, 'on'>;
  on: boolean;
}

class Scope {
  disposed = false;
  /** True until `activate` returns; `onReady` callbacks wait for the end of it. */
  activating = true;
  readonly legend = new Map<string, LegendRec>();
  readonly tabs = new Map<string, SettingsTabItem>();
  readonly corners = new Map<string, CornerPanelItem>();
  readonly sides = new Map<string, SideRec>();
  readonly drive = new Map<string, DriveRec>();
  readonly ready = new Set<ReadyReg>();
  readonly clicks = new Set<ClickReg>();
  readonly polls = new Set<PollHandle>();
  /** Cleanups returned by `onReady` callbacks, for the map attached now. */
  readyCleanups: (() => void)[] = [];
  popup: PopupHandle | null = null;
  constructor(readonly info: PluginInfo, readonly plugin: WebPlugin) {}
}

// --- validation ---------------------------------------------------------------

function str(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new PluginApiError(`${what} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function localId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new PluginApiError(`${what} must be lowercase letters, digits and hyphens (got ${JSON.stringify(value)})`);
  }
  return value;
}

function swatchOf(value: LegendSwatch): LegendSwatch {
  if (typeof value !== 'object' || value === null || !SWATCH_KINDS.has(value.kind)) {
    throw new PluginApiError(`legend swatch.kind must be one of ${[...SWATCH_KINDS].join(', ')}`);
  }
  if (typeof value.color !== 'string' || !COLOR_RE.test(value.color) || /url\s*\(/i.test(value.color)) {
    throw new PluginApiError('legend swatch.color must be a plain CSS colour or gradient (no url())');
  }
  const out: LegendSwatch = { kind: value.kind, color: value.color };
  if (value.glyph !== undefined) out.glyph = str(value.glyph, 'legend swatch.glyph', 8);
  return out;
}

function viewOf<P>(def: { render?: unknown; component?: unknown }, what: string): ViewSpec<P> {
  const hasRender = typeof def.render === 'function';
  const hasComponent = typeof def.component === 'function' || (typeof def.component === 'object' && def.component !== null);
  if (hasRender === hasComponent) throw new PluginApiError(`${what} needs exactly one of render or component`);
  return def as ViewSpec<P>;
}

/**
 * `/foo/bar?x=1` -> `/api/plugins/<id>/foo/bar?x=1`. Refuses anything that could
 * leave the plugin's own route space: a missing or doubled leading slash (which
 * would make a protocol-relative URL), a `..` or `.` segment (also percent-encoded),
 * a backslash, a fragment, or control characters.
 */
export function pluginRoute(pluginId: string, path: string): string {
  const bad = (): never => {
    throw new PluginApiError(`data path must be a plugin route like "/places" (got ${JSON.stringify(path)})`);
  };
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return bad();
  // eslint-disable-next-line no-control-regex
  if (path.includes('\\') || path.includes('#') || /[\u0000-\u001f]/.test(path)) return bad();
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split('?', 1)[0]);
  } catch {
    return bad();
  }
  if (decoded.includes('\\') || decoded.split('/').some((seg) => seg === '..' || seg === '.')) return bad();
  return `/api/plugins/${pluginId}${path}`;
}

/** Remove the layers and sources whose id starts with `<pluginId>:` (what `scopedId` makes). Quiet if the map is already gone. */
function removeScoped(map: MapLibreMap, pluginId: string): void {
  const prefix = `${pluginId}:`;
  try {
    const style = map.getStyle();
    for (const layer of style.layers ?? []) if (layer.id.startsWith(prefix)) map.removeLayer(layer.id);
    for (const source of Object.keys(style.sources ?? {})) if (source.startsWith(prefix)) map.removeSource(source);
  } catch {
    // The map was removed first (page unmount): its layers went with it.
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A drive source's `tuning`, checked and filled with the host's defaults. Throws on an option
 * name the host does not know (a typo would otherwise be silently ignored) and on a value that
 * is not a finite number within its range.
 */
function tuningOf(value: unknown): ResolvedDriveTuning {
  const out: ResolvedDriveTuning = { ...DRIVE_TUNING_DEFAULTS };
  if (value === undefined) return out;
  if (typeof value !== 'object' || value === null) throw new PluginApiError('drive source tuning must be an object');
  const given = value as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(DRIVE_TUNING_LIMITS, key)) throw new PluginApiError(`drive source tuning has no option "${key}"`);
  }
  for (const key of Object.keys(DRIVE_TUNING_LIMITS) as (keyof ResolvedDriveTuning)[]) {
    const v = given[key];
    if (v === undefined) continue;
    const { min, max } = DRIVE_TUNING_LIMITS[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new PluginApiError(`drive tuning ${key} must be a number from ${min} to ${max}`);
    }
    out[key] = v;
  }
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginApiError(`${what} took longer than ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// --- the registry -------------------------------------------------------------

export class PluginRegistry {
  private readonly listeners = new Set<() => void>();
  private readonly scopes = new Map<string, Scope>();
  private readonly records = new Map<string, PluginRecord>();
  private readonly visibility: Record<string, boolean> = {};
  private chosen: Record<string, boolean> | null = null;
  private attachment: MapAttachment | null = null;
  private clickHandler: ((e: MapMouseEvent) => void) | null = null;
  private user: PluginUser | null = null;
  private phase: RegistrySnapshot['phase'] = 'idle';
  private snap: RegistrySnapshot;

  constructor(private readonly options: RegistryOptions = {}) {
    this.snap = this.build();
  }

  // ---- React store contract -------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RegistrySnapshot => this.snap;

  // ---- app -> registry ------------------------------------------------------

  setUser(user: PluginUser | null): void {
    this.user = user;
  }

  setPhase(phase: RegistrySnapshot['phase']): void {
    this.phase = phase;
    this.emit();
  }

  /** The legend toggle for a global key, as the UI reads it. */
  legendOn(globalKey: string): boolean {
    return this.visibility[globalKey] ?? false;
  }

  /** Flip a toggle from the Legend or the toolbar. */
  setLegendOn(globalKey: string, on: boolean): void {
    if (this.visibility[globalKey] === undefined || this.visibility[globalKey] === on) return;
    const found = this.findLegend(globalKey);
    this.visibility[globalKey] = on;
    this.remember(globalKey, on);
    if (found) {
      this.applyLayers(found.rec);
      for (const cb of [...found.rec.listeners]) this.guard(found.scope, 'legend onChange', () => cb(on));
    }
    this.emit();
  }

  /** Turn a Drive source on or off, from its Drive button. The host starts or stops it to match. */
  setDriveSourceOn(globalKey: string, on: boolean): void {
    for (const scope of this.scopes.values()) {
      for (const rec of scope.drive.values()) {
        if (rec.item.id === globalKey && rec.on !== on) {
          rec.on = on;
          this.emit();
          return;
        }
      }
    }
  }

  /** Close whichever side panel is open (the core panels opened, or the map was clicked). */
  closeSidePanels(): void {
    let changed = false;
    for (const scope of this.scopes.values()) {
      for (const rec of scope.sides.values()) {
        if (rec.open) {
          rec.open = false;
          rec.data = undefined;
          changed = true;
        }
      }
    }
    if (changed) this.emit();
  }

  /** A bundle that never got as far as `activate` (fetch, import or shape failure). */
  recordFailure(info: PluginInfo, message: string): void {
    this.records.set(info.id, { ...info, state: 'failed', error: message });
    console.error(`[plugin:${info.id}] failed to load: ${message}`);
    logActivity('Plugins', `${info.name} could not be loaded`, 'error');
    this.emit();
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Run a plugin's `activate` with a host bound to this registry. If it throws or
   * times out, everything it contributed is rolled back and the error is rethrown.
   */
  async activate(info: PluginInfo, plugin: WebPlugin): Promise<void> {
    if (this.scopes.has(info.id)) throw new PluginApiError(`${info.id} is already active`);
    const scope = new Scope(info, plugin);
    this.scopes.set(info.id, scope);
    try {
      await withTimeout(Promise.resolve(plugin.activate(this.buildHost(scope))), ACTIVATE_TIMEOUT_MS, 'activate()');
    } catch (err) {
      this.dispose(info.id, { callDeactivate: false });
      this.recordFailure(info, messageOf(err));
      throw err;
    }
    if (scope.disposed) return;
    scope.activating = false;
    this.records.set(info.id, { ...info, state: 'active' });
    if (this.attachment) this.runReady(scope, this.attachment);
    this.emit();
  }

  /** Remove a plugin and everything it contributed. Safe to call for an unknown id. */
  dispose(id: string, opts: { callDeactivate?: boolean } = {}): void {
    const scope = this.scopes.get(id);
    if (!scope) return;
    scope.disposed = true;
    this.scopes.delete(id);
    this.records.delete(id);
    if (opts.callDeactivate !== false && scope.plugin.deactivate) {
      const hook = scope.plugin.deactivate.bind(scope.plugin);
      this.guard(scope, 'deactivate', () => void Promise.resolve(hook()).catch((err: unknown) => this.reportError(scope, 'deactivate', err)));
    }
    for (const poll of scope.polls) poll.stop();
    scope.polls.clear();
    this.teardownOnMap(scope);
    scope.popup?.close();
    scope.popup = null;
    this.emit();
  }

  // ---- map ------------------------------------------------------------------

  /**
   * Bind the registry to a map whose style has loaded. Runs every `onReady`
   * callback, applies legend visibility, and starts routing clicks. Returns the
   * detach function to call when the map is removed.
   */
  attachMap(attachment: MapAttachment): () => void {
    if (this.attachment) this.detachMap();
    this.attachment = attachment;
    const handler = (e: MapMouseEvent): void => this.routeClick(e);
    this.clickHandler = handler;
    attachment.map.on('click', handler);
    for (const scope of this.scopes.values()) if (!scope.activating) this.runReady(scope, attachment);
    this.emit();
    return () => {
      if (this.attachment === attachment) this.detachMap();
    };
  }

  private detachMap(): void {
    const att = this.attachment;
    if (!att) return;
    if (this.clickHandler) att.map.off('click', this.clickHandler);
    this.clickHandler = null;
    for (const scope of this.scopes.values()) {
      for (const cleanup of scope.readyCleanups.splice(0)) this.guard(scope, 'onReady cleanup', cleanup);
      // Take the plugin's layers and sources off too, so a map that is attached again (React StrictMode, a remount
      // that kept the map) gets a clean onReady rather than "layer already exists". On a removed map this is a no-op.
      removeScoped(att.map, scope.info.id);
      scope.popup?.close();
      scope.popup = null;
    }
    this.attachment = null;
    this.emit();
  }

  private runReady(scope: Scope, att: MapAttachment): void {
    for (const reg of [...scope.ready]) {
      const cleanup = this.guard(scope, 'map.onReady', () => reg.cb(att.map));
      if (typeof cleanup === 'function') scope.readyCleanups.push(cleanup);
    }
    for (const rec of scope.legend.values()) this.applyLayers(rec);
  }

  /** A disposed plugin leaves nothing on the live map. */
  private teardownOnMap(scope: Scope): void {
    for (const cleanup of scope.readyCleanups.splice(0)) this.guard(scope, 'onReady cleanup', cleanup);
    if (this.attachment) removeScoped(this.attachment.map, scope.info.id);
  }

  private routeClick(e: MapMouseEvent): void {
    const att = this.attachment;
    if (!att || !att.isInteractive()) return;
    let handled = false;
    for (const scope of [...this.scopes.values()]) {
      for (const reg of [...scope.clicks]) {
        const layers = reg.layers.filter((id) => att.map.getLayer(id));
        if (layers.length === 0) continue;
        const features = att.map.queryRenderedFeatures(e.point, { layers });
        if (features.length === 0) continue;
        handled = true;
        const click: PluginMapClick = {
          lngLat: [e.lngLat.lng, e.lngLat.lat],
          point: { x: e.point.x, y: e.point.y },
          features,
          layerId: features[0].layer.id,
          map: att.map,
        };
        this.guard(scope, 'map.onClick', () => reg.cb(click));
      }
    }
    if (!handled) this.closeSidePanels();
  }

  private applyLayers(rec: LegendRec): void {
    const att = this.attachment;
    if (!att) return;
    const value = this.visibility[`${rec.item.pluginId}:${rec.item.key}`] ? 'visible' : 'none';
    for (const id of rec.layers) {
      try {
        if (att.map.getLayer(id)) att.map.setLayoutProperty(id, 'visibility', value);
      } catch {
        // The map is being torn down; there is nothing left to show or hide.
      }
    }
  }

  // ---- persistence ----------------------------------------------------------

  private store(): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (this.options.storage !== undefined) return this.options.storage;
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null; // access itself can throw (blocked site data)
    }
  }

  private choices(): Record<string, boolean> {
    if (this.chosen) return this.chosen;
    const out: Record<string, boolean> = {};
    try {
      const saved: unknown = JSON.parse(this.store()?.getItem(VISIBILITY_KEY) ?? '{}');
      if (typeof saved === 'object' && saved !== null) {
        for (const [k, v] of Object.entries(saved)) if (typeof v === 'boolean') out[k] = v;
      }
    } catch {
      // no storage, or unreadable: start from the defaults
    }
    return (this.chosen = out);
  }

  /** Only what the person chose is saved, so a plugin update can still change a default nobody touched. */
  private remember(globalKey: string, on: boolean): void {
    this.choices()[globalKey] = on;
    try {
      this.store()?.setItem(VISIBILITY_KEY, JSON.stringify(this.choices()));
    } catch {
      // private mode: the choice lasts until the page closes
    }
  }

  // ---- internals ------------------------------------------------------------

  private findLegend(globalKey: string): { scope: Scope; rec: LegendRec } | null {
    for (const scope of this.scopes.values()) {
      for (const rec of scope.legend.values()) {
        if (`${rec.item.pluginId}:${rec.item.key}` === globalKey) return { scope, rec };
      }
    }
    return null;
  }

  /** Run a plugin-supplied callback so that a throw is logged and goes no further. */
  private guard<T>(scope: Scope, what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.reportError(scope, what, err);
      return undefined;
    }
  }

  private reportError(scope: Scope, what: string, err: unknown): void {
    console.error(`[plugin:${scope.info.id}] ${what}: ${messageOf(err)}`);
    logActivity(scope.info.name, `Something went wrong (${what}); this plugin may be partly unavailable`, 'error');
  }

  private emit(): void {
    this.snap = this.build();
    for (const listener of [...this.listeners]) listener();
  }

  private build(): RegistrySnapshot {
    const legend: LegendItem[] = [];
    const settingsTabs: SettingsTabItem[] = [];
    const cornerPanels: CornerPanelItem[] = [];
    const sidePanels: SidePanelItem[] = [];
    const driveSources: DriveSourceItem[] = [];
    for (const scope of this.scopes.values()) {
      for (const rec of scope.legend.values()) {
        legend.push({ ...rec.item, on: this.visibility[`${rec.item.pluginId}:${rec.item.key}`] ?? false });
      }
      settingsTabs.push(...scope.tabs.values());
      cornerPanels.push(...scope.corners.values());
      for (const rec of scope.sides.values()) sidePanels.push({ ...rec.item, open: rec.open, data: rec.data });
      for (const rec of scope.drive.values()) driveSources.push({ ...rec.item, on: rec.on });
    }
    return {
      phase: this.phase,
      plugins: [...this.records.values()],
      legend,
      settingsTabs,
      cornerPanels,
      sidePanels,
      openSidePanel: sidePanels.find((p) => p.open) ?? null,
      driveSources,
    };
  }

  // ---- the host a plugin sees -----------------------------------------------

  private buildHost(scope: Scope): PluginHost {
    const reg = this;
    const { id, name, version } = scope.info;
    const live = (): void => {
      if (scope.disposed) throw new PluginApiError(`${id} is no longer active`);
    };
    const remove = <K>(map: Map<K, unknown>, key: K): (() => void) => () => {
      if (map.delete(key)) reg.emit();
    };
    const globalId = (local: string): string => `${id}:${local}`;

    const hostMap: PluginHost['map'] = {
      get current() {
        return reg.attachment?.map ?? null;
      },
      onReady(cb) {
        live();
        const entry: ReadyReg = { cb };
        scope.ready.add(entry);
        if (reg.attachment && !scope.activating) {
          const att = reg.attachment;
          const cleanup = reg.guard(scope, 'map.onReady', () => cb(att.map));
          if (typeof cleanup === 'function') scope.readyCleanups.push(cleanup);
          for (const rec of scope.legend.values()) reg.applyLayers(rec);
        }
        return () => void scope.ready.delete(entry);
      },
      scopedId: (local) => globalId(str(local, 'scopedId name', 80)),
      onClick(layers, cb) {
        live();
        const entry: ClickReg = { layers: [...layers], cb };
        scope.clicks.add(entry);
        return () => void scope.clicks.delete(entry);
      },
      showPopup(at: LngLat, content) {
        live();
        const att = reg.attachment;
        if (!att) return { close() {} };
        scope.popup?.close();
        // A string goes through setText, which never parses HTML.
        const popup = att.createPopup().setLngLat(at);
        (typeof content === 'string' ? popup.setText(content) : popup.setDOMContent(content)).addTo(att.map);
        const handle: PopupHandle = { close: () => popup.remove() };
        scope.popup = handle;
        return handle;
      },
    };

    const hostLegend: PluginHost['legend'] = {
      add(def: LegendEntryDef): LegendEntry {
        live();
        const key = localId(def.key, 'legend key');
        if (scope.legend.has(key)) throw new PluginApiError(`legend key "${key}" is already registered`);
        const globalKey = globalId(key);
        const defaultOn = def.defaultOn === true;
        const item: LegendRec['item'] = {
          globalKey, pluginId: id, key,
          label: str(def.label, 'legend label', 60),
          swatch: swatchOf(def.swatch),
          menu: def.menu === 'scout' ? 'scout' : 'live',
          defaultOn,
        };
        if (def.title !== undefined) item.title = str(def.title, 'legend title', 200);
        const rec: LegendRec = { item, layers: [...(def.layers ?? [])], listeners: new Set() };
        scope.legend.set(key, rec);
        if (reg.visibility[globalKey] === undefined) reg.visibility[globalKey] = reg.choices()[globalKey] ?? defaultOn;
        reg.emit();
        return {
          key,
          get on() {
            return reg.visibility[globalKey] ?? false;
          },
          setOn: (on) => reg.setLegendOn(globalKey, !!on),
          toggle: () => reg.setLegendOn(globalKey, !reg.visibility[globalKey]),
          onChange(cb) {
            rec.listeners.add(cb);
            return () => void rec.listeners.delete(cb);
          },
          syncLayers: () => reg.applyLayers(rec),
        };
      },
    };

    const hostSettings: PluginHost['settings'] = {
      addTab(def) {
        live();
        const tabId = localId(def.id, 'settings tab id');
        if (scope.tabs.has(tabId)) throw new PluginApiError(`settings tab "${tabId}" is already registered`);
        const group = def.group ?? 'Plugins';
        if (!SETTINGS_GROUPS.has(group)) throw new PluginApiError(`settings group must be one of ${[...SETTINGS_GROUPS].join(', ')}`);
        scope.tabs.set(tabId, {
          id: globalId(tabId), pluginId: id, group,
          label: str(def.label, 'settings tab label', 40),
          admin: def.admin !== false,
          view: viewOf<SettingsTabProps>(def, 'settings tab'),
        });
        reg.emit();
        return remove(scope.tabs, tabId);
      },
    };

    const hostPanel: PluginHost['panel'] = {
      addCorner(def) {
        live();
        const cornerId = localId(def.id, 'corner panel id');
        if (scope.corners.has(cornerId)) throw new PluginApiError(`corner panel "${cornerId}" is already registered`);
        scope.corners.set(cornerId, {
          id: globalId(cornerId), pluginId: id,
          whileOn: def.whileOn === undefined ? null : globalId(localId(def.whileOn, 'corner panel whileOn')),
          view: viewOf<Record<string, never>>(def, 'corner panel'),
        });
        reg.emit();
        return remove(scope.corners, cornerId);
      },
      addSide<T>(def: SidePanelDef<T>): SidePanelHandle<T> {
        live();
        const panelId = localId(def.id, 'side panel id');
        if (scope.sides.has(panelId)) throw new PluginApiError(`side panel "${panelId}" is already registered`);
        const view = viewOf<SidePanelProps<T>>(def, 'side panel') as unknown as ViewSpec<SidePanelProps<unknown>>;
        const rec: SideRec = {
          item: { id: globalId(panelId), pluginId: id, label: str(def.label, 'side panel label', 80), view },
          open: false,
          data: undefined,
        };
        scope.sides.set(panelId, rec);
        reg.emit();
        return {
          get isOpen() {
            return rec.open;
          },
          open(data: T) {
            live();
            for (const s of reg.scopes.values()) for (const other of s.sides.values()) if (other !== rec) other.open = false;
            rec.open = true;
            rec.data = data;
            reg.emit();
          },
          close() {
            if (!rec.open) return;
            rec.open = false;
            rec.data = undefined;
            reg.emit();
          },
        };
      },
    };

    const hostDrive: PluginHost['drive'] = {
      addAlertSource(def) {
        live();
        const sourceId = localId(def.id, 'drive source id');
        if (scope.drive.has(sourceId)) throw new PluginApiError(`drive source "${sourceId}" is already registered`);
        if (typeof def.start !== 'function') throw new PluginApiError('drive source start must be a function');
        const filter = def.filter ?? 'nearby';
        if (filter !== 'nearby' && filter !== 'route-ahead') throw new PluginApiError("drive source filter must be 'nearby' or 'route-ahead'");
        const runs = def.runs ?? 'drive';
        if (runs !== 'drive' && runs !== 'always') throw new PluginApiError("drive source runs must be 'drive' or 'always'");
        const tuning = tuningOf(def.tuning);
        const item: DriveRec['item'] = { id: globalId(sourceId), pluginId: id, label: str(def.label, 'drive source label', 60), filter, runs, tuning, start: def.start };
        if (def.title !== undefined) item.title = str(def.title, 'drive source title', 200);
        scope.drive.set(sourceId, { item, on: def.defaultOn !== false });
        reg.emit();
        return remove(scope.drive, sourceId);
      },
    };

    const hostData: PluginHost['data'] = {
      url: (path) => pluginRoute(id, path),
      fetch: (path, init) => {
        live();
        const doFetch = reg.options.fetch ?? globalThis.fetch.bind(globalThis);
        return doFetch(pluginRoute(id, path), init);
      },
      async json<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await hostData.fetch(path, init);
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error : `HTTP ${res.status}`;
          const error = Object.assign(new Error(message), { name: 'PluginHttpError' as const, status: res.status });
          throw error satisfies PluginHttpError;
        }
        return (await res.json()) as T;
      },
      poll(options) {
        live();
        const handle = createPoll(options, (err) => reg.reportError(scope, 'poll', err));
        scope.polls.add(handle);
        return handle;
      },
    };

    return {
      id, name, version,
      apiVersion: WEB_API_VERSION,
      get user() {
        return reg.user;
      },
      map: hostMap,
      legend: hostLegend,
      settings: hostSettings,
      panel: hostPanel,
      drive: hostDrive,
      data: hostData,
      assetUrl: (path) => {
        const clean = str(path, 'asset path', 200);
        if (clean.startsWith('/') || clean.split('/').some((seg) => seg === '..' || seg === '.')) {
          throw new PluginApiError(`asset path must be relative to assets/ (got ${JSON.stringify(path)})`);
        }
        return `/plugins/${id}/${version}/assets/${clean}`;
      },
      ui: { react: React },
      log: {
        info: (m) => console.info(`[plugin:${id}] ${m}`),
        warn: (m) => console.warn(`[plugin:${id}] ${m}`),
        error: (m) => console.error(`[plugin:${id}] ${m}`),
      },
      activity: (message: string, level: ActivityLevel = 'info') => {
        if (!scope.disposed) logActivity(name, String(message).slice(0, 200), level);
      },
    };
  }
}

/** The page-wide registry. Tests build their own with `new PluginRegistry()`. */
export const pluginRegistry = new PluginRegistry();
