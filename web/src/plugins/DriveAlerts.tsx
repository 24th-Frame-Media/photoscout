import { useSyncExternalStore } from 'react';
import type { Fix } from '../drive/camera.js';
import type { LngLat } from '../drive/geometry.js';
import { formatDistance } from '../drive/format.js';
import type { DriveRunner } from './driveRunner.js';
import { bannerAlert } from './nearestAlert.js';
import { usePluginRegistry } from './react.js';
import { pluginRegistry, type PluginRegistry } from './registry.js';

/**
 * Drive-mode slot for plugin sources: while a drive is on, the nearest alert that
 * passes each source's filter, beside the route banner (as core's warning is); and in
 * any phase, one status line per source that has one (as core's status hints are).
 * The runner (driveRunner.ts) starts and stops the sources.
 */
export function PluginDriveAlerts({ runner, fix, route, driving, registry = pluginRegistry }: { runner: DriveRunner; fix: Fix | null; route: LngLat[] | null; driving: boolean; registry?: PluginRegistry }) {
  const snap = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);
  const sources = usePluginRegistry(registry).driveSources;
  const position: LngLat | null = fix ? [fix.lng, fix.lat] : null;
  const filterOf = (sourceId: string) => sources.find((s) => s.id === sourceId)?.filter ?? 'nearby';
  const near = driving ? bannerAlert(snap.alerts, filterOf, route, position) : null;
  const lines = sources.filter((s) => s.on && snap.status[s.id]);
  return (
    <>
      {near && (
        <div className="drive__report" role="status">
          <strong>{near.alert.glyph && <span className="drive__report-icon" aria-hidden="true">{near.alert.glyph} </span>}{near.alert.title}</strong> · {formatDistance(near.distanceM)} {near.ahead ? 'ahead' : 'away'}
          {near.alert.detail && <span className="drive__report-street">{near.alert.detail}</span>}
        </div>
      )}
      {lines.map((s) => (
        <div key={s.id} className={`drive__status drive__status--${snap.status[s.id].state}`} role="status">{snap.status[s.id].text}</div>
      ))}
    </>
  );
}

/** One button per plugin drive source, labelled "<label> on" or "<label> off", as core's "Reports on/off". */
export function PluginDriveToggles({ registry = pluginRegistry }: { registry?: PluginRegistry }) {
  const sources = usePluginRegistry(registry).driveSources;
  return (
    <>
      {sources.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`drivebtn${s.on ? '' : ' is-off'}`}
          aria-pressed={s.on}
          title={s.title ?? s.label}
          onClick={() => registry.setDriveSourceOn(s.id, !s.on)}
        >
          {s.label} {s.on ? 'on' : 'off'}
        </button>
      ))}
    </>
  );
}
