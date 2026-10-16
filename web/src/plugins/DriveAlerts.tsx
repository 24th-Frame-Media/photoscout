import { useEffect, useMemo, useRef, useState } from 'react';
import { logActivity } from '../activity.js';
import { useDriveMap } from '../drive/context.js';
import { formatDistance } from '../drive/format.js';
import type { DriveAlert, LngLat } from './api.js';
import { nearestAlert } from './nearestAlert.js';
import { usePluginRegistry } from './react.js';

/**
 * Drive-mode slot for plugin alert sources. Starts every registered source
 * once the Drive map is loaded, and shows the nearest alert beside the route
 * banner. Minimal on purpose: see the TODO list on `DriveApi.addAlertSource`
 * (route-ahead filtering, speech, map icons, an on/off button).
 */
export function PluginDriveAlerts() {
  const { map, fix } = useDriveMap();
  const sources = usePluginRegistry().driveSources;
  // The effect below must restart only when the set of sources changes, not on every registry update.
  const key = sources.map((s) => s.id).join('|');
  const latest = useRef(sources);
  latest.current = sources;
  const position = useRef<LngLat | null>(null);
  position.current = fix ? [fix.lng, fix.lat] : null;
  const [bySource, setBySource] = useState<Record<string, readonly DriveAlert[]>>({});

  useEffect(() => {
    if (!map || !key) return;
    const stops: (() => void)[] = [];
    for (const source of latest.current) {
      try {
        const stop = source.start({
          map,
          position: () => position.current,
          report: (alerts) => setBySource((prev) => ({ ...prev, [source.id]: alerts })),
        });
        if (typeof stop === 'function') stops.push(stop);
      } catch (err) {
        console.error(`[plugin:${source.pluginId}] drive source ${source.id}: ${err instanceof Error ? err.message : String(err)}`);
        logActivity('Plugins', 'A plugin could not start in Drive', 'error');
      }
    }
    return () => {
      for (const stop of stops) {
        try { stop(); } catch (err) { console.error(`drive source cleanup: ${err instanceof Error ? err.message : String(err)}`); }
      }
      setBySource({});
    };
  }, [map, key]);

  const near = useMemo(() => nearestAlert(bySource, fix ? [fix.lng, fix.lat] : null), [bySource, fix]);
  if (!near) return null;
  return (
    <div className="drive__report" role="status">
      <strong>{near.alert.glyph && <span className="drive__report-icon" aria-hidden="true">{near.alert.glyph} </span>}{near.alert.title}</strong> · {formatDistance(near.distanceM)} away
      {near.alert.detail && <span className="drive__report-street">{near.alert.detail}</span>}
    </div>
  );
}
