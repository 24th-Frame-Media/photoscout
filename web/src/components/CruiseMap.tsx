import { useEffect, useRef } from 'react';
import { Map as MlMap, Marker } from 'maplibre-gl';
import type { RouteType } from '../api.js';
import { STYLE_URL } from '../map/layers.js';

/** The route colours the main map uses (map/routeLayer.ts), so a cruise's line looks like a route. */
const COLOR: Record<RouteType, string> = { sprint: '#f97316', circuit: '#a855f7' };

type LngLat = [number, number];

export interface CruiseEdit {
  /** What a click on the map does: add a point to the line, or put the meeting point there. */
  mode: 'line' | 'meet';
  onPoint(p: LngLat): void;
  onMeet(lat: number, lng: number): void;
}

/**
 * A cruise on a map: its line and its meeting point. Read-only on an event, or with `edit` the
 * map the organiser draws on. `fitKey` is when to re-centre on the line (a different route chosen);
 * it is left alone while drawing, so the map does not jump under the finger.
 */
export default function CruiseMap({ line, type = 'sprint', meet, edit, fitKey = '' }: {
  line: LngLat[]; type?: RouteType; meet: { lat: number; lng: number } | null; edit?: CruiseEdit; fitKey?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const marker = useRef<Marker | null>(null);
  const latest = useRef({ line, type, meet, edit, fitKey });
  latest.current = { line, type, meet, edit, fitKey };
  const fittedFor = useRef<string | null>(null);

  function draw() {
    const m = map.current;
    if (!m || !ready.current) return;
    const { line, type, meet, edit, fitKey } = latest.current;
    const lineSource = m.getSource('cruise-line') as import('maplibre-gl').GeoJSONSource;
    lineSource.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.length >= 2 ? line : [] } });
    (m.getSource('cruise-pts') as import('maplibre-gl').GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: edit?.mode === 'line' || (edit && line.length < 2) ? line.map((c) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: c } })) : [],
    });
    m.setPaintProperty('cruise-line', 'line-color', COLOR[type]);
    if (meet) {
      if (!marker.current) marker.current = new Marker({ color: '#4cc3ff' }).setLngLat([meet.lng, meet.lat]).addTo(m);
      else marker.current.setLngLat([meet.lng, meet.lat]);
    } else { marker.current?.remove(); marker.current = null; }
    if (fittedFor.current !== fitKey && (line.length >= 2 || meet)) {
      fittedFor.current = fitKey;
      const pts: LngLat[] = [...line, ...(meet ? [[meet.lng, meet.lat] as LngLat] : [])];
      if (pts.length === 1) m.jumpTo({ center: pts[0], zoom: 12 });
      else m.fitBounds([[Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]], { padding: 40, maxZoom: 15, duration: 0 });
    }
  }

  useEffect(() => {
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: [149.577, -33.419], zoom: 8, attributionControl: { compact: true } });
    map.current = m;
    m.on('load', () => {
      m.addSource('cruise-line', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } });
      m.addSource('cruise-pts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'cruise-line-casing', type: 'line', source: 'cruise-line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05070f', 'line-width': 8, 'line-opacity': 0.5 } });
      m.addLayer({ id: 'cruise-line', type: 'line', source: 'cruise-line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR.sprint, 'line-width': 4 } });
      m.addLayer({ id: 'cruise-pts', type: 'circle', source: 'cruise-pts', paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#05070f', 'circle-stroke-width': 1.5 } });
      ready.current = true;
      draw();
    });
    m.on('click', (e) => {
      const edit = latest.current.edit;
      if (!edit) return;
      if (edit.mode === 'meet') edit.onMeet(e.lngLat.lat, e.lngLat.lng);
      else edit.onPoint([e.lngLat.lng, e.lngLat.lat]);
    });
    return () => { marker.current?.remove(); marker.current = null; ready.current = false; fittedFor.current = null; m.remove(); map.current = null; };
  }, []);

  useEffect(draw, [line, type, meet?.lat, meet?.lng, edit?.mode, fitKey]);

  return <div ref={container} className={`cruisemap${edit ? ' is-editing' : ''}`} aria-label={edit ? 'Map: click to draw the route or place the meeting point' : 'Map of the cruise route'} />;
}
