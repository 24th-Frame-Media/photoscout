import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { WazeHeatPoint } from '../api.js';
import { WAZE_LAYERS } from './waze.js';

export const POLICE_HEAT_LAYER = 'police-heat';
const POLICE_HEAT_SOURCE = 'police-heat';

/** Time windows the map's range selector offers, in ms. */
export const POLICE_HEAT_WINDOWS = [
  { label: '1h', ms: 3_600_000 }, { label: '2h', ms: 7_200_000 }, { label: '6h', ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 }, { label: '7d', ms: 604_800_000 },
] as const;
export const POLICE_HEAT_DEFAULT_MS = 7_200_000;

export function initPoliceHeat(map: MlMap) {
  if (map.getSource(POLICE_HEAT_SOURCE)) return;
  map.addSource(POLICE_HEAT_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Reports: Waze / Google' });
  // Below the report pins, so individual reports stay visible on top of the density.
  const beforeId = WAZE_LAYERS.find((id) => map.getLayer(id));
  map.addLayer({ id: POLICE_HEAT_LAYER, type: 'heatmap', source: POLICE_HEAT_SOURCE, layout: { visibility: 'none' }, paint: {
    'heatmap-weight': ['to-number', ['get', 'weight'], 0],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 13, 1, 16, 1.6],
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 10, 12, 13, 22, 16, 36],
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(37,99,235,0)', 0.2, '#2563eb', 0.45, '#84cc16', 0.7, '#facc15', 1, '#ef4444'],
    'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 0.5],
  } }, beforeId);
}

export function updatePoliceHeat(map: MlMap, points: WazeHeatPoint[]) {
  (map.getSource(POLICE_HEAT_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: points.map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: p.point }, properties: { weight: p.weight },
  })) });
}

export function setPoliceHeatVisible(map: MlMap, on: boolean) {
  if (map.getLayer(POLICE_HEAT_LAYER)) map.setLayoutProperty(POLICE_HEAT_LAYER, 'visibility', on ? 'visible' : 'none');
}
