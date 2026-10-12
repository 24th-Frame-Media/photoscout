/**
 * Route map rendering: static directed line with chevron arrows.
 *
 * Layered route paint keeps routes legible over both the vector basemap and
 * satellite imagery:
 * - 'route-glow': broad translucent contrast bed.
 * - 'route-casing': crisp high-contrast outline.
 * - 'route-lines': the typed route line (sprint=solid, circuit=dashed).
 * - 'route-pulse': a bright comet that travels along each route, start to finish.
 * - 'route-arrows': chevrons along the line showing the direction of travel.
 *
 * The map source 'routes' is a GeoJSON LineString FeatureCollection with one
 * Feature per route. Keeping long routes intact avoids multiplying a 1,000-point
 * route into 999 independent feature/layer evaluations.
 *
 * Vertex handles during editing are driven by the RouteEditor UI layer.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { GeoJSONSource } from 'maplibre-gl';
import type { Route } from '../api.js';

export const ROUTE_LAYERS = ['route-glow', 'route-casing', 'route-lines', 'route-pulse', 'route-arrows', 'route-staging-halo', 'route-staging'] as const;

/** Layer IDs — also re-exported for clickable list and toggling. */
export const ROUTE_GLOW_LAYER = 'route-glow';
export const ROUTE_CASING_LAYER = 'route-casing';
export const ROUTE_LINE_LAYER = 'route-lines';
export const ROUTE_PULSE_LAYER = 'route-pulse';
export const ROUTE_ARROW_LAYER = 'route-arrows';
const ROUTE_ARROW_IMAGE = 'route-arrow';
export const ROUTE_STAGING_HALO_LAYER = 'route-staging-halo';
export const ROUTE_STAGING_LAYER = 'route-staging';
export const ROUTE_SOURCE = 'routes';
export const ROUTE_STAGING_SOURCE = 'route-staging-pts';

const ROUTE_COLOR = '#f97316';   // orange-500
const ROUTE_CIRCUIT_COLOR = '#a855f7'; // purple-500
const ROUTE_CASING_DARK = '#05070f';
const ROUTE_CASING_LIGHT = '#fff7ed';

/** White chevron (pointing right) with a dark outline, drawn once as a map image. */
function arrowImage(): ImageData {
  const size = 32, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.lineCap = g.lineJoin = 'round';
  g.beginPath(); g.moveTo(10, 8); g.lineTo(21, 16); g.lineTo(10, 24);
  g.strokeStyle = ROUTE_CASING_DARK; g.lineWidth = 8; g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.stroke();
  return g.getImageData(0, 0, size, size);
}

/** Add route sources and layers to an already-initialised map. */
export function initRouteLayers(map: MlMap, beforeLayer?: string) {
  const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: empty(), lineMetrics: true });
  map.addSource(ROUTE_STAGING_SOURCE, { type: 'geojson', data: empty() });

  map.addLayer({
    id: ROUTE_GLOW_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['get', 'selected'], ROUTE_CASING_LIGHT, ROUTE_CASING_DARK] as any,
      'line-width': ['case', ['get', 'selected'], 13, 10] as any,
      'line-opacity': ['case', ['get', 'selected'], 0.42, 0.28] as any,
      'line-blur': 2.8,
    },
  }, beforeLayer);

  map.addLayer({
    id: ROUTE_CASING_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_CASING_DARK,
      'line-width': ['case', ['get', 'selected'], 9, 7] as any,
      'line-opacity': 0.95,
    },
  }, beforeLayer);

  // Base line — thicker sprint/circuit line.
  map.addLayer({
    id: ROUTE_LINE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match', ['get', 'type'],
        'circuit', ROUTE_CIRCUIT_COLOR,
        ROUTE_COLOR,
      ] as any,
      'line-width': ['case', ['get', 'selected'], 5, 4] as any,
      'line-opacity': 1,
      'line-dasharray': ['match', ['get', 'type'], 'circuit', ['literal', [1.8, 1.1]], ['literal', [1, 0]]] as any,
    },
  }, beforeLayer);

  // Travelling comet: line-gradient over line-progress, so it runs start to finish on every route.
  map.addLayer({
    id: ROUTE_PULSE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['case', ['get', 'selected'], 5, 4] as any,
      'line-blur': 1,
      'line-gradient': routePulseGradient(0),
    },
  }, beforeLayer);
  animateRoutePulse(map);

  // Direction chevrons along the line (no text/fonts needed).
  if (!map.hasImage(ROUTE_ARROW_IMAGE)) map.addImage(ROUTE_ARROW_IMAGE, arrowImage(), { pixelRatio: 2 });
  map.addLayer({
    id: ROUTE_ARROW_LAYER,
    type: 'symbol',
    source: ROUTE_SOURCE,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 100,
      'icon-image': ROUTE_ARROW_IMAGE,
      'icon-size': ['case', ['get', 'selected'], 0.9, 0.7] as any,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-rotation-alignment': 'map',
    },
  }, beforeLayer);

  // Staging point marker: a labelled badge, separate from route vertices.
  map.addLayer({
    id: ROUTE_STAGING_HALO_LAYER,
    type: 'circle',
    source: ROUTE_STAGING_SOURCE,
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 14, 12] as any,
      'circle-color': ROUTE_CASING_DARK,
      'circle-opacity': 0.88,
      'circle-stroke-color': ROUTE_CASING_LIGHT,
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 2] as any,
    },
  }, beforeLayer);

  map.addLayer({
    id: ROUTE_STAGING_LAYER,
    type: 'symbol',
    source: ROUTE_STAGING_SOURCE,
    layout: {
      'text-field': 'S',
      'text-size': ['case', ['get', 'selected'], 14, 12] as any,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#fef08a',
      'text-halo-color': ROUTE_CASING_DARK,
      'text-halo-width': 2,
    },
  }, beforeLayer);
}

export function routeFeatureCollections(routes: Route[], selectedId: string | null): {
  segments: GeoJSON.FeatureCollection;
  staging: GeoJSON.FeatureCollection;
} {
  const features: GeoJSON.Feature[] = [];
  const stagingFeatures: GeoJSON.Feature[] = [];

  for (const route of routes) {
    if (route.vertices.length >= 2) {
      const coordinates = route.type === 'circuit'
        ? [...route.vertices, route.vertices[0]]
        : route.vertices;
      features.push({
        type: 'Feature',
        properties: {
          id: route.id,
          routeId: route.id,
          type: route.type,
          selected: route.id === selectedId,
        },
        geometry: { type: 'LineString', coordinates },
      });
    }

    if (route.staging) {
      stagingFeatures.push({
        type: 'Feature',
        properties: { id: route.id, routeId: route.id, selected: route.id === selectedId },
        geometry: { type: 'Point', coordinates: [route.staging.lng, route.staging.lat] },
      });
    }
  }

  return {
    segments: { type: 'FeatureCollection', features },
    staging: { type: 'FeatureCollection', features: stagingFeatures },
  };
}

/** Push a new routes FeatureCollection to the map. */
export function updateRoutes(map: MlMap, routes: Route[], selectedId: string | null) {
  const src = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
  const stagSrc = map.getSource(ROUTE_STAGING_SOURCE) as GeoJSONSource | undefined;
  if (!src || !stagSrc) return;

  const { segments, staging } = routeFeatureCollections(routes, selectedId);
  src.setData(segments);
  hasRoutes.set(map, segments.features.length > 0);
  stagSrc.setData(staging);
}

const PULSE_PERIOD_MS = 3200;
const PULSE_LEN = 0.22; // share of the route the comet tail covers
const WHITE = [255, 255, 255];

/**
 * Comet gradient at phase 0..1. The head runs from 0 to 1 + PULSE_LEN so the tail
 * leaves the finish smoothly before the next lap starts (no pop at the wrap).
 */
export function routePulseGradient(phase: number) {
  const head = phase * (1 + PULSE_LEN);
  // [progress, alpha]: fade-in tail, bright head, hard front edge.
  const stops: [number, number][] = [[head - PULSE_LEN, 0], [head - 0.02, 0.95], [head, 1], [head + 0.004, 0]];
  // line-gradient needs ascending stops inside [0, 1]: clip, sampling alpha at the edges.
  const alphaAt = (x: number) => {
    if (x <= stops[0][0]) return 0;
    for (let i = 1; i < stops.length; i++) {
      const [x0, a0] = stops[i - 1], [x1, a1] = stops[i];
      if (x <= x1) return a0 + (a1 - a0) * (x - x0) / (x1 - x0);
    }
    return 0;
  };
  const rgba = (a: number) => `rgba(${WHITE.join(',')},${a.toFixed(3)})`;
  const expr: any[] = ['interpolate', ['linear'], ['line-progress'], 0, rgba(alphaAt(0))];
  for (const [x, a] of stops) if (x > 0 && x < 1) expr.push(x, rgba(a));
  expr.push(1, rgba(alphaAt(1)));
  return expr as any;
}

/** Whether the map currently draws any route, so the comet can idle. */
const hasRoutes = new WeakMap<MlMap, boolean>();

/** Drive the comet at ~30 fps while routes are visible; idles (no repaints) otherwise. */
function animateRoutePulse(map: MlMap) {
  let raf = 0;
  let last = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (now - last < 33 || !hasRoutes.get(map) || !map.getLayer(ROUTE_PULSE_LAYER)) return;
    if (map.getLayoutProperty(ROUTE_PULSE_LAYER, 'visibility') === 'none') return;
    // ponytail: pauses during camera moves in 3D only, where each paint change re-renders terrain textures.
    if (map.getTerrain() && map.isMoving()) return;
    last = now;
    map.setPaintProperty(ROUTE_PULSE_LAYER, 'line-gradient', routePulseGradient((now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS));
  };
  raf = requestAnimationFrame(frame);
  map.once('remove', () => cancelAnimationFrame(raf));
}
