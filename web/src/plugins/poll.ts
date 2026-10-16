import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bbox, PollHandle, PollOptions } from './api.js';

/**
 * The poll helper behind `host.data.poll`. Same cadence as the core Waze feed
 * (map/useWazeReports.ts) without React, so a plugin gets it for free:
 * first poll at once, then every `intervalMs`, never while the tab is hidden,
 * at most one request per 5 s, a newer request aborts the one in flight and a
 * late answer to a superseded request is dropped.
 */

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_GAP_MS = 5_000;
export const MOVE_DEBOUNCE_MS = 600;

/** The map's view clamped to the world, or null if it is degenerate (zero-width, or not loaded). */
export function viewBbox(map: MapLibreMap): Bbox | null {
  try {
    const b = map.getBounds();
    const bbox = {
      minLng: Math.max(-180, b.getWest()),
      maxLng: Math.min(180, b.getEast()),
      minLat: Math.max(-90, b.getSouth()),
      maxLat: Math.min(90, b.getNorth()),
    };
    return bbox.minLng < bbox.maxLng && bbox.minLat < bbox.maxLat ? bbox : null;
  } catch {
    return null;
  }
}

/**
 * @param report where an error goes when the plugin gave no `onError`, or its
 *   `onError`/`onData`/`onStop` itself threw. The host logs it.
 */
export function createPoll<T>(options: PollOptions<T>, report: (err: unknown) => void): PollHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const map = options.map ?? null;
  const hidden = (): boolean => typeof document !== 'undefined' && document.hidden;

  let running = false;
  let permanentlyStopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let asking: AbortController | null = null;
  let lastRequest = Number.NEGATIVE_INFINITY;
  let sequence = 0;
  let detach: (() => void) | null = null;
  let unwatch: (() => void) | null = null;

  const schedule = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), Math.max(0, ms));
  };

  async function refresh(): Promise<void> {
    if (!running || hidden()) return;
    const wait = MIN_POLL_GAP_MS - (Date.now() - lastRequest);
    if (wait > 0) {
      schedule(wait);
      return;
    }
    const bounds = map ? viewBbox(map) : null;
    if (map && !bounds) return;
    lastRequest = Date.now();
    asking?.abort();
    const ac = (asking = new AbortController());
    const request = ++sequence;
    try {
      const data = await options.fetch({ signal: ac.signal, bounds });
      if (!running || request !== sequence) return;
      options.onData(data);
      const retry = options.retryAfterMs?.(data);
      if (retry != null) schedule(retry);
    } catch (err) {
      if (!running || request !== sequence || ac.signal.aborted) return;
      try {
        if (options.onError) options.onError(err);
        else report(err);
      } catch (inner) {
        report(inner);
      }
    }
  }

  function start(): void {
    if (running || permanentlyStopped) return;
    running = true;
    interval = setInterval(() => void refresh(), intervalMs);
    const cleanups: (() => void)[] = [];
    if (typeof document !== 'undefined') {
      const visible = (): void => {
        if (!document.hidden) void refresh();
      };
      document.addEventListener('visibilitychange', visible);
      cleanups.push(() => document.removeEventListener('visibilitychange', visible));
    }
    if (map) {
      const moved = (): void => schedule(MOVE_DEBOUNCE_MS);
      const gone = (): void => handle.stop();
      if (options.refreshOnMove) map.on('moveend', moved);
      map.on('remove', gone);
      cleanups.push(() => {
        map.off('moveend', moved);
        map.off('remove', gone);
      });
    }
    detach = () => cleanups.forEach((fn) => fn());
    void refresh();
  }

  function pause(): void {
    if (!running) return;
    running = false;
    clearTimeout(timer);
    clearInterval(interval);
    asking?.abort();
    asking = null;
    detach?.();
    detach = null;
    try {
      options.onStop?.();
    } catch (err) {
      report(err);
    }
  }

  const handle: PollHandle = {
    refresh: () => void refresh(),
    stop: () => {
      permanentlyStopped = true;
      unwatch?.();
      unwatch = null;
      pause();
    },
  };

  const gate = options.while;
  if (gate) {
    unwatch = gate.onChange((on) => (on ? start() : pause()));
    if (gate.on) start();
  } else {
    start();
  }
  return handle;
}
