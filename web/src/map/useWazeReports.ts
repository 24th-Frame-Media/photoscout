import { useEffect, useState } from 'react';
import { Popup, type Map as MlMap } from 'maplibre-gl';
import { api, type WazeAlert } from '../api.js';
import { initWazeLayers, updateWazeReports, WAZE_LAYERS } from './waze.js';

export function useWazeReports(map: MlMap | null, enabled: boolean, priority: 'map' | 'navigation' = 'map') {
  const [alerts, setAlerts] = useState<WazeAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<string | null>(null);
  const [state, setState] = useState<'fresh' | 'queued' | 'scanning' | 'stale' | null>(null);
  useEffect(() => {
    if (!map) return;
    initWazeLayers(map);
    for (const id of WAZE_LAYERS) map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none');
    if (!enabled) { updateWazeReports(map, []); setAlerts([]); setError(null); return; }
    let stopped = false, sequence = 0, timer: ReturnType<typeof setTimeout>;
    let asking: AbortController | null = null;
    let lastRequest = 0;
    let popup: Popup | null = null;
    async function refresh() {
      if (document.hidden || stopped) return;
      if (Date.now() - lastRequest < 5000) {
        clearTimeout(timer); timer = setTimeout(() => void refresh(), 5000 - (Date.now() - lastRequest)); return;
      }
      lastRequest = Date.now();
      asking?.abort();
      const ac = asking = new AbortController(), request = ++sequence;
      const bounds = map!.getBounds();
      const bbox = { minLng: Math.max(-180, bounds.getWest()), maxLng: Math.min(180, bounds.getEast()), minLat: Math.max(-90, bounds.getSouth()), maxLat: Math.min(90, bounds.getNorth()) };
      if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) return;
      try {
        const response = await api.wazeAlerts(bbox, ac.signal, priority);
        if (stopped || request !== sequence) return;
        setAlerts(response.alerts); setCoverage(response.coverage); setError(null);
        setState(response.state);
        updateWazeReports(map!, response.alerts);
        if (response.state !== 'fresh') { clearTimeout(timer); timer = setTimeout(() => void refresh(), response.retryAfterMs); }
      } catch (err) {
        if (stopped || request !== sequence || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Waze reports unavailable');
        setAlerts([]); updateWazeReports(map!, []); popup?.remove();
      }
    }
    const moved = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 600); };
    const clicked = (e: { features?: GeoJSON.Feature[]; lngLat: { lng: number; lat: number } }) => {
      const props = e.features?.[0]?.properties;
      if (!props) return;
      const content = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = String(props.title); content.append(title);
      for (const text of [props.street, props.description, typeof props.reportTime === 'number' ? `Reported ${new Date(props.reportTime).toLocaleTimeString()}` : '', 'Waze community report']) {
        if (text) { const p = document.createElement('p'); p.textContent = String(text); content.append(p); }
      }
      popup?.remove(); popup = new Popup().setLngLat(e.lngLat).setDOMContent(content).addTo(map);
    };
    map.on('moveend', moved); map.on('click', 'waze-reports', clicked);
    const interval = setInterval(() => void refresh(), 30_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { stopped = true; clearTimeout(timer); clearInterval(interval); asking?.abort(); popup?.remove(); map.off('moveend', moved); map.off('click', 'waze-reports', clicked); document.removeEventListener('visibilitychange', visible); };
  }, [map, enabled, priority]);
  return { alerts, error, coverage, state };
}
