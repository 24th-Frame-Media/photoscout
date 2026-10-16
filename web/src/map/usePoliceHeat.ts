import { useEffect, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { api } from '../api.js';
import { initPoliceHeat, setPoliceHeatVisible, updatePoliceHeat } from './policeHeat.js';

/** Historical police heatmap: while enabled, fetches the view's weighted reports for a time window and keeps them on the map. */
export function usePoliceHeat(map: MlMap | null, enabled: boolean, windowMs: number) {
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!map) return;
    const m = map;
    initPoliceHeat(m);
    setPoliceHeatVisible(m, enabled);
    if (!enabled) { updatePoliceHeat(m, []); setCount(0); setError(null); return; }
    let stopped = false, sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking: AbortController | null = null;
    async function refresh() {
      if (document.hidden || stopped) return;
      asking?.abort();
      const ac = asking = new AbortController(), request = ++sequence;
      const bounds = m.getBounds();
      const bbox = { minLng: Math.max(-180, bounds.getWest()), maxLng: Math.min(180, bounds.getEast()), minLat: Math.max(-90, bounds.getSouth()), maxLat: Math.min(90, bounds.getNorth()) };
      if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) return;
      try {
        const response = await api.wazeHeatmap(bbox, windowMs, ac.signal);
        if (stopped || request !== sequence) return;
        updatePoliceHeat(m, response.points);
        setCount(response.points.length); setError(null);
      } catch (err) {
        if (stopped || request !== sequence || ac.signal.aborted) return;
        updatePoliceHeat(m, []); setCount(0);
        setError(err instanceof Error ? err.message : 'Police heatmap unavailable');
      }
    }
    const moved = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 600); };
    m.on('moveend', moved);
    const interval = setInterval(() => void refresh(), 60_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      stopped = true; clearTimeout(timer); clearInterval(interval); asking?.abort();
      m.off('moveend', moved); document.removeEventListener('visibilitychange', visible);
    };
  }, [map, enabled, windowMs]);
  return { error, count };
}
