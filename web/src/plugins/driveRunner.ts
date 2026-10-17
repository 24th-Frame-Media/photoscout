/**
 * The host side of the Drive plugin slot. It starts each source that is on while a
 * drive runs, gives it a `DriveSourceContext`, and keeps what the source reports
 * (alerts, a status line, pins and images on the Drive map, popups, spoken prompts)
 * for the Drive screen to show. Framework-free: the React layer in DriveAlerts.tsx reads
 * `getSnapshot`, and the tests drive it with a fake map.
 */
import type { Map as MapLibreMap, Popup } from 'maplibre-gl';
import { logActivity } from '../activity.js';
import type { Fix } from '../drive/camera.js';
import type {
  DriveAlert,
  DriveImage,
  DriveSourceContext,
  DriveSpeakOptions,
  DriveStatus,
  LngLat,
  PluginMapClick,
  PopupHandle,
  SpeakRefusal,
  SpeakResult,
} from './api.js';
import { routeAheadM } from './routeAhead.js';
import { PluginApiError, type DriveSourceItem } from './registry.js';

const STATUS_STATES: ReadonlySet<string> = new Set(['waiting', 'checking', 'stale', 'error', 'ok']);

/** What the Drive screen lends the runner. Getters, so each read is the latest value. */
export interface DriveRunnerEnv {
  /** The latest GPS fix, or null before the first. */
  fix(): Fix | null;
  /** The route being followed, as the Drive screen draws it; null when no navigation is under way. */
  route(): LngLat[] | null;
  /** The heading the Drive map turns to, or null. */
  heading(): number | null;
  /** Whether speech may happen at all: the browser can speak and the driver has not muted it. */
  voiceOn(): boolean;
  /** Speak through the Drive voice. */
  speak(text: string): void;
  /** A maplibre `Popup`, for `showPopup`. Injected (the screen passes `new Popup()`) so this module needs no maplibre at runtime. */
  createPopup(): Popup;
}

/** What the running sources have reported, keyed by `<pluginId>:<key>`. Replaced whenever it changes. */
export interface DriveRunnerSnapshot {
  alerts: Readonly<Record<string, readonly DriveAlert[]>>;
  /** Status lines, without the `ok` ones (those are shown as nothing). */
  status: Readonly<Record<string, DriveStatus>>;
}

interface Claim {
  layers: ReadonlySet<string>;
  onTap?: (tap: PluginMapClick) => void;
}

interface Run {
  item: DriveSourceItem;
  /** What the source's `scopedId` puts in front of every id it adds to the Drive map. */
  prefix: string;
  claims: Claim[];
  alerts: readonly DriveAlert[];
  status: DriveStatus | null;
  cleanup: (() => void) | null;
  /** Images this source added, by their full id. Removed when the source stops. */
  images: Set<string>;
  popup: PopupHandle | null;
  /** Set when the run has ended. A run that failed to start stays in the table, stopped, until the driver toggles it or the drive ends. */
  stopped: boolean;
}

export class DriveRunner {
  private readonly runs = new Map<string, Run>();
  /** Keys already spoken this drive (`<pluginId>:<key>` + key). */
  private readonly spoken = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snap: DriveRunnerSnapshot = { alerts: {}, status: {} };
  /** Whether a drive is on: speech is said only then. */
  private driving = false;

  constructor(private readonly map: MapLibreMap, private readonly env: DriveRunnerEnv) {}

  // ---- React store contract ---------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DriveRunnerSnapshot => this.snap;

  // ---- lifecycle --------------------------------------------------------------

  /**
   * Make the running sources match `items`. A source runs when the driver has it on and
   * either a drive is on (`driving`) or it runs 'always'. Leaving a drive forgets what
   * was spoken, so the next drive can say it again.
   */
  sync(items: readonly DriveSourceItem[], driving = true): void {
    this.driving = driving;
    if (!driving) this.spoken.clear();
    const wanted = new Map(items.filter((item) => item.on && (driving || item.runs === 'always')).map((item) => [item.id, item]));
    for (const id of [...this.runs.keys()]) if (!wanted.has(id)) this.stop(id);
    for (const [id, item] of wanted) if (!this.runs.has(id)) this.start(item);
  }

  /** The Drive screen is closing: stop every source. */
  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
    this.spoken.clear();
    this.driving = false;
  }

  /**
   * Offer a tap on the Drive map. Returns true when it landed on a pin a source
   * declared with `mapLayers`; the Drive screen then does not pick a destination.
   */
  tap(e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }): boolean {
    const claims = [...this.runs.values()].flatMap((run) => run.claims.map((claim) => ({ run, claim })));
    if (claims.length === 0) return false;
    const layers = [...new Set(claims.flatMap(({ claim }) => [...claim.layers]))].filter((id) => this.map.getLayer(id));
    if (layers.length === 0) return false;
    const features = this.map.queryRenderedFeatures([e.point.x, e.point.y], { layers });
    if (features.length === 0) return false;
    const layerId = features[0].layer.id;
    const owner = claims.find(({ claim }) => claim.layers.has(layerId));
    if (owner?.claim.onTap) {
      const onTap = owner.claim.onTap;
      this.guard(owner.run, 'mapLayers onTap', () => onTap({
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        point: { x: e.point.x, y: e.point.y },
        features,
        layerId,
        map: this.map,
      }));
    }
    return true;
  }

  private start(item: DriveSourceItem): void {
    const run: Run = { item, prefix: `${item.id}:`, claims: [], alerts: [], status: null, cleanup: null, images: new Set(), popup: null, stopped: false };
    this.runs.set(item.id, run);
    try {
      const cleanup = item.start(this.contextFor(run));
      if (typeof cleanup === 'function') run.cleanup = cleanup;
    } catch (err) {
      console.error(`[plugin:${item.pluginId}] drive source ${item.id} could not start: ${messageOf(err)}`);
      logActivity('Plugins', 'A plugin could not start in Drive', 'error');
      this.teardown(run);
      this.publish();
    }
  }

  private stop(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    this.teardown(run);
    this.publish();
  }

  private teardown(run: Run): void {
    if (run.stopped) return;
    run.stopped = true;
    if (run.cleanup) {
      const cleanup = run.cleanup;
      run.cleanup = null;
      this.guard(run, 'cleanup', cleanup);
    }
    this.closePopup(run);
    this.clearMap(run);
    for (const id of run.images) this.dropImage(id);
    run.images.clear();
    run.claims = [];
    run.alerts = [];
    run.status = null;
  }

  /** Remove the layers the source declared or scoped, and its sources. Quiet if the map is already gone. */
  private clearMap(run: Run): void {
    try {
      const style = this.map.getStyle();
      const layers = new Set<string>();
      for (const claim of run.claims) for (const id of claim.layers) layers.add(id);
      for (const layer of style.layers ?? []) if (layer.id.startsWith(run.prefix)) layers.add(layer.id);
      for (const id of layers) if (this.map.getLayer(id)) this.map.removeLayer(id);
      for (const source of Object.keys(style.sources ?? {})) if (source.startsWith(run.prefix)) this.map.removeSource(source);
    } catch {
      // The Drive map is being removed with the screen; its layers went with it.
    }
  }

  /** Remove one image from the Drive map's style, if it is there. Quiet if the map is already gone. */
  private dropImage(id: string): void {
    try {
      if (this.map.hasImage(id)) this.map.removeImage(id);
    } catch {
      // The Drive map is being removed with the screen; its images went with it.
    }
  }

  private closePopup(run: Run): void {
    const popup = run.popup;
    run.popup = null;
    if (!popup) return;
    try {
      popup.close();
    } catch {
      // The Drive map is being removed; its popup went with it.
    }
  }

  // ---- what a source sees -----------------------------------------------------

  private contextFor(run: Run): DriveSourceContext {
    const { env, map } = this;
    /** A full id for `name` on this source, after checking the name the way `scopedId` always has. */
    const scoped = (name: string): string => {
      if (typeof name !== 'string' || name.trim() === '' || name.length > 80) {
        throw new PluginApiError('scopedId name must be a non-empty string of at most 80 characters');
      }
      return `${run.prefix}${name}`;
    };
    return {
      map,
      fix: () => {
        const fix = env.fix();
        return fix ? { point: [fix.lng, fix.lat], accuracyM: fix.accuracy, ageMs: Math.max(0, Date.now() - fix.t) } : null;
      },
      route: () => env.route(),
      heading: () => env.heading(),
      routeAhead: (point: LngLat) => {
        const route = env.route();
        const fix = env.fix();
        return route && fix ? routeAheadM(route, [fix.lng, fix.lat], point, run.item.tuning) : null;
      },
      report: (alerts) => {
        if (!Array.isArray(alerts)) throw new PluginApiError('report needs a list of alerts');
        if (run.stopped) return;
        run.alerts = alerts.filter(isPlaced);
        this.publish();
      },
      setStatus: (status) => {
        if (run.stopped) return;
        run.status = status === null ? null : statusOf(status);
        this.publish();
      },
      speak: (text, opts) => this.speakFor(run, text, opts),
      addImage: (name, image: DriveImage) => {
        const id = scoped(name);
        if (run.stopped) return id;
        // maplibre reports a second add of the same id as an error event, so replace it explicitly.
        this.dropImage(id);
        map.addImage(id, image);
        run.images.add(id);
        return id;
      },
      removeImage: (name) => {
        const id = scoped(name);
        if (!run.images.delete(id)) return;
        this.dropImage(id);
      },
      showPopup: (at: LngLat, content) => {
        if (!Array.isArray(at) || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) {
          throw new PluginApiError('showPopup needs a [lng, lat] point');
        }
        if (typeof content !== 'string' && (typeof content !== 'object' || content === null)) {
          throw new PluginApiError('showPopup content must be a string or an element');
        }
        if (run.stopped) return { close() {} };
        this.closePopup(run);
        // A string goes through setText, which never parses HTML.
        const popup = env.createPopup().setLngLat(at);
        (typeof content === 'string' ? popup.setText(content) : popup.setDOMContent(content)).addTo(map);
        const handle: PopupHandle = {
          close: () => {
            try {
              popup.remove();
            } catch {
              // The Drive map is being removed; its popup went with it.
            }
            if (run.popup === handle) run.popup = null;
          },
        };
        run.popup = handle;
        return handle;
      },
      scopedId: (name) => scoped(name),
      mapLayers: (layerIds, opts) => {
        if (!Array.isArray(layerIds) || layerIds.some((id) => typeof id !== 'string' || id === '')) {
          throw new PluginApiError('mapLayers needs a list of layer ids');
        }
        if (opts?.onTap !== undefined && typeof opts.onTap !== 'function') throw new PluginApiError('mapLayers onTap must be a function');
        if (run.stopped) return () => {};
        const claim: Claim = { layers: new Set(layerIds), onTap: opts?.onTap };
        run.claims.push(claim);
        return () => {
          run.claims = run.claims.filter((c) => c !== claim);
        };
      },
    };
  }

  /**
   * The host's gate on speech, in the order it refuses: the source has stopped, no drive is on,
   * the key was already said, the Voice button is off, no fix, a stale fix, a loose fix. The
   * fix limits come from the source's own tuning.
   */
  private speakFor(run: Run, text: string, opts?: DriveSpeakOptions): SpeakResult {
    if (typeof text !== 'string' || text.trim() === '' || text.length > 200) {
      throw new PluginApiError('speak text must be a non-empty string of at most 200 characters');
    }
    const refused = (reason: SpeakRefusal): SpeakResult => ({ spoken: false, reason });
    if (run.stopped) return refused('stopped');
    if (!this.driving) return refused('not-driving');
    const key = opts?.key === undefined ? null : `${run.item.id}\n${String(opts.key)}`;
    if (key !== null && this.spoken.has(key)) return refused('duplicate');
    if (!this.env.voiceOn()) return refused('voice-off');
    const fix = this.env.fix();
    if (!fix) return refused('no-fix');
    if (Date.now() - fix.t > run.item.tuning.speakMaxAgeMs) return refused('stale');
    if (fix.accuracy > run.item.tuning.speakMaxAccuracyM) return refused('inaccurate');
    this.env.speak(text);
    if (key !== null) this.spoken.add(key);
    return { spoken: true };
  }

  // ---- internals --------------------------------------------------------------

  private publish(): void {
    const alerts: Record<string, readonly DriveAlert[]> = {};
    const status: Record<string, DriveStatus> = {};
    for (const run of this.runs.values()) {
      if (run.stopped) continue;
      if (run.alerts.length > 0) alerts[run.item.id] = run.alerts;
      if (run.status && run.status.state !== 'ok') status[run.item.id] = run.status;
    }
    this.snap = { alerts, status };
    for (const listener of [...this.listeners]) listener();
  }

  private guard(run: Pick<Run, 'item'>, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[plugin:${run.item.pluginId}] drive source ${run.item.id} ${what}: ${messageOf(err)}`);
      logActivity('Plugins', 'Something went wrong in Drive; a plugin may be partly unavailable', 'error');
    }
  }
}

/** An alert the banner can place: a point with two finite coordinates. */
function isPlaced(alert: DriveAlert): boolean {
  return Array.isArray(alert?.point) && Number.isFinite(alert.point[0]) && Number.isFinite(alert.point[1]);
}

function statusOf(status: DriveStatus): DriveStatus {
  if (typeof status !== 'object' || !STATUS_STATES.has(status.state) || typeof status.text !== 'string') {
    throw new PluginApiError("setStatus needs { state, text }, with state one of waiting, checking, stale, error, ok");
  }
  return { state: status.state, text: status.text.slice(0, 200) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
