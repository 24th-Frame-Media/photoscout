import type { Map as MlMap, GeoJSONSource } from 'maplibre-gl';
import type { WazeAlert } from '../api.js';

export const WAZE_LAYERS = ['waze-reports', 'waze-report-labels'];
export const reportIconType = (alert: Pick<WazeAlert, 'type' | 'subType'>): string =>
  alert.type === 'POLICE' && ['POLICE_MOBILE_CAMERA', 'POLICE_WITH_MOBILE_CAMERA'].includes(alert.subType ?? '') ? 'CAMERA' : alert.type;
export const reportEmoji = (alert: Pick<WazeAlert, 'type'>): string => ({
  POLICE: '👮', HAZARD: '⚠️', CONSTRUCTION: '🚧', CAMERA: '',
  ROAD_CLOSED: '⛔', ACCIDENT: '💥', JAM: '🚗',
} as Record<string, string>)[alert.type] ?? '⚠️';
export const reportLabel = (alert: Pick<WazeAlert, 'type' | 'subType'>): string => {
  if (alert.type === 'POLICE') return reportIconType(alert) === 'CAMERA' ? 'Mobile speed camera reported' : ['POLICE_HIDING', 'POLICE_HIDDEN'].includes(alert.subType ?? '') ? 'Police hiding nearby' : 'Police reported';
  if (alert.type === 'CAMERA') return 'Traffic camera';
  if (alert.type === 'ROAD_CLOSED') return 'Road closed';
  if (alert.type === 'ACCIDENT') return 'Crash reported';
  if (alert.type === 'JAM') return 'Traffic jam reported';
  return 'Hazard reported';
};

export function initWazeLayers(map: MlMap) {
  if (map.getSource('waze-reports')) return;
  // Rasterise local emoji fonts: the basemap's glyph server does not carry colour emoji.
  for (const type of ['POLICE', 'HAZARD', 'CONSTRUCTION', 'CAMERA', 'ROAD_CLOSED', 'ACCIDENT', 'JAM']) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (type === 'CAMERA') {
      ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fbbf24';
      ctx.beginPath(); ctx.roundRect(15, 10, 34, 30, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#172b49'; ctx.beginPath(); ctx.arc(32, 25, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.arc(32, 25, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(32, 42); ctx.lineTo(32, 56); ctx.moveTo(22, 56); ctx.lineTo(42, 56); ctx.stroke();
    } else ctx.fillText(reportEmoji({ type }), 32, 34);
    map.addImage(`waze-emoji-${type}`, ctx.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
  map.addSource('waze-reports', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Reports: Waze / Google' });
  map.addLayer({ id: 'waze-reports', type: 'circle', source: 'waze-reports', paint: {
    'circle-radius': 16, 'circle-color': '#172b49',
    'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
  } });
  map.addLayer({ id: 'waze-report-labels', type: 'symbol', source: 'waze-reports', layout: {
    'icon-image': ['concat', 'waze-emoji-', ['get', 'iconType']],
    'icon-size': 1, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
  } });
}

export function updateWazeReports(map: MlMap, alerts: WazeAlert[]) {
  (map.getSource('waze-reports') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: alerts.map(a => ({
    type: 'Feature', id: a.id, geometry: { type: 'Point', coordinates: a.point },
    properties: { id: a.id, type: a.type, iconType: reportIconType(a), title: reportLabel(a), description: a.description ?? '', street: a.street ?? '', reportTime: a.reportTime },
  })) });
}
