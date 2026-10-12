import { useEffect, useRef } from 'react';
import { Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { STYLE_URL, buildingLayerIds } from '../map/layers.js';
import { registerTerrainShadowProtocol, setTerrainShadowSun, setTerrainShadowTerrain, SHADOW_RASTER_MAX_Z } from '../map/terrainShadowSource.js';
import { sunLook } from '../map/sunLook.js';
import { sunPos } from '../map/sun.js';

import { TERRARIUM_URL as TERRARIUM } from '../map/terrainShadow.js';
const SHADOW_COLOR = '#0a0c1a';

/** Applies sun-driven look (sky/light/hillshade/terrain-shadow) to an already-loaded map. */
function applyLook(map: MlMap, sun: { altitude: number; azimuth: number }) {
  const look = sunLook(sun);
  map.setSky(look.sky as any);
  map.setLight(look.light);
  if (map.getLayer('hillshade')) for (const [k, v] of Object.entries(look.hillshade)) map.setPaintProperty('hillshade', k as any, v as any);
  for (const id of buildingLayerIds(map)) {
    if (map.getLayer(id)?.type === 'fill-extrusion') map.setPaintProperty(id, 'fill-extrusion-color', sun.altitude > 0 ? (sun.altitude < 8 ? '#cbbfb3' : '#d9d6d0') : '#2a2e3d');
  }
  if (sun.altitude > 0) setTerrainShadowSun(map, sun);
  setTerrainShadowTerrain(map, sun.altitude > 0);
  if (map.getLayer('terrain-shadow')) map.setLayoutProperty('terrain-shadow', 'visibility', sun.altitude > 0 ? 'visible' : 'none');
}

/** Camera placed at the spot, looking along `facing` at near-eye-level pitch. maplibre-gl 6.11 has no free-camera
 * API in this build, so we approximate eye level with a high pitch + tight zoom: the camera sits behind and just
 * above the centre point, looking past it in the bearing direction. */
function placeCamera(map: MlMap, lat: number, lng: number, facing: number) {
  map.jumpTo({ center: [lng, lat], bearing: facing, pitch: 85, zoom: 18 });
}

export interface ViewPreviewProps {
  lat: number;
  lng: number;
  facingDeg: number | null;
  fovDeg: number | null;
  time: Date;
}

export default function ViewPreview({ lat, lng, facingDeg, fovDeg, time }: ViewPreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);

  useEffect(() => {
    registerTerrainShadowProtocol(SHADOW_COLOR);
    const m = new MlMap({ container: container.current!, style: STYLE_URL, center: [lng, lat], zoom: 18, pitch: 85, maxPitch: 89, interactive: true, attributionControl: false });
    m.once('style.load', () => {
      try { m.setSourceTileLodParams(4.0, 1.8); } catch { /* ignore */ }
      m.addSource('dem', { type: 'raster-dem', tiles: [TERRARIUM], tileSize: 256, maxzoom: 14, encoding: 'terrarium' });
      m.setTerrain({ source: 'dem', exaggeration: 1.4 });
      const layers = m.getStyle().layers ?? [];
      const firstRoad = layers.find((l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'transportation')?.id;
      m.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-illumination-anchor': 'map', 'hillshade-method': 'combined', 'hillshade-exaggeration': 0.5 } }, firstRoad);
      const firstBuilding = buildingLayerIds(m)[0] ?? firstRoad;
      m.addSource('terrain-shadow', { type: 'raster', tiles: ['terrainshadow://{z}/{x}/{y}?az=180&alt=45'], tileSize: 256, minzoom: 9, maxzoom: SHADOW_RASTER_MAX_Z });
      m.addLayer({ id: 'terrain-shadow', type: 'raster', source: 'terrain-shadow', minzoom: 9, paint: { 'raster-opacity': 0.3, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, firstBuilding);
      mapRef.current = m;
      placeCamera(m, lat, lng, facingDeg ?? sunPos(time, lat, lng).azimuth);
      applyLook(m, sunPos(time, lat, lng));
    });
    return () => { mapRef.current = null; m.remove(); };
    // Mount once; lat/lng/facing/time changes are applied to the live map below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const sun = sunPos(time, lat, lng);
    placeCamera(m, lat, lng, facingDeg ?? sun.azimuth);
    applyLook(m, sun);
  }, [lat, lng, facingDeg, fovDeg, time.getTime()]);

  return <div className="viewpreview__map" ref={container} aria-label="View from the spot" />;
}
