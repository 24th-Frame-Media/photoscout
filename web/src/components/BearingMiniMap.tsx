import { useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, Map as MlMap, type GeoJSONSource } from 'maplibre-gl';
import { buildingLayerIds, DEM_SOURCE, ESRI, STYLE_URL } from '../map/layers.js';
import { normalizeAnchorBearing, selectedBearingProjectionGeoJSON } from '../map/sunAnchor.js';
import { sunriseSunset, sunriseSunsetAzimuthRange, type SunriseSunsetAzimuthRangeResult } from '../map/sun.js';
import { bearing as geoBearing, destination, haversineKm } from '../map/geo.js';

export interface BearingMiniMapProps {
  lat: number;
  lng: number;
  bearingDeg: number | null;
  bestHit?: { time: Date; azimuthDeg: number };
  onChange: (deg: number) => void;
}

export const BEARING_MINI_MAP_STEP_DEG = 1;
export const BEARING_MINI_MAP_SHIFT_STEP_DEG = 10;
export const DEFAULT_LINE_LENGTH_KM = 0.6;
const BOUNDS_MARGIN_FACTOR = 1.25;
const FONT = ['Noto Sans Regular'];

const STORAGE_KEY_3D = 'ls.miniMap.3d';
const STORAGE_KEY_SATELLITE = 'ls.miniMap.satellite';

const SOURCE_WEDGES = 'mini-wedges';
const SOURCE_WEDGES_LABELS = 'mini-wedges-labels';
const SOURCE_SUN_RAYS = 'mini-sun-rays';
const SOURCE_BEARING = 'mini-bearing';
const SOURCE_BEST_HIT = 'mini-best-hit';
const SOURCE_SPOT = 'mini-spot';

export interface LngLatBoundsLike {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

export interface VisibleBoundsMapLike {
  getBounds(): LngLatBoundsLike;
}

/**
 * Computes initial compass bearing from origin spot to pointer's geographic coordinate,
 * normalised to [0, 360).
 */
export function pointCoordToBearing(
  origin: { lat: number; lng: number },
  pointCoord: { lat: number; lng: number },
): number {
  return normalizeAnchorBearing(geoBearing(origin.lat, origin.lng, pointCoord.lat, pointCoord.lng));
}

/**
 * Computes length (in km) to reach past the edge of the visible map.
 * Measures distance from the spot to each visible corner and multiplies by a margin factor.
 */
export function computeRayLengthKm(
  spot: { lat: number; lng: number },
  bounds: LngLatBoundsLike | null | undefined,
  marginFactor = BOUNDS_MARGIN_FACTOR,
): number {
  if (!bounds || typeof bounds.getWest !== 'function') {
    return DEFAULT_LINE_LENGTH_KM;
  }
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();

  const corners = [
    { lat: north, lng: west },
    { lat: north, lng: east },
    { lat: south, lng: west },
    { lat: south, lng: east },
  ];

  let maxDistKm = 0;
  for (const corner of corners) {
    const dist = haversineKm(spot.lat, spot.lng, corner.lat, corner.lng);
    if (dist > maxDistKm) {
      maxDistKm = dist;
    }
  }

  return Math.max(DEFAULT_LINE_LENGTH_KM, maxDistKm * marginFactor);
}

/**
 * Pure calculation to nudge a bearing with arrow keys.
 * Left decreases bearing, Right increases bearing.
 * Shift modifier uses step of 10, default is 1.
 * Always normalizes within [0, 360).
 */
export function nudgeBearing(
  currentBearingDeg: number | null,
  key: string,
  shiftKey = false,
): number | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') {
    return null;
  }
  const current = currentBearingDeg ?? 0;
  const step = shiftKey ? BEARING_MINI_MAP_SHIFT_STEP_DEG : BEARING_MINI_MAP_STEP_DEG;
  const delta = key === 'ArrowRight' ? step : -step;
  return normalizeAnchorBearing(current + delta);
}

/** Ray lengths overshoot the view (corner distance x margin); labels and markers need a radius that stays on screen. */
export function insideViewKm(rayLengthKm: number): number {
  return (rayLengthKm / BOUNDS_MARGIN_FACTOR) * 0.6;
}

function fmtDateShort(d: Date): string {
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * Constructs a sector (wedge) polygon coordinates ring from minDeg to maxDeg.
 * When clockwise: start bearing minDeg up to maxDeg.
 */
export function buildSectorPolygon(
  lat: number,
  lng: number,
  startDeg: number,
  endDeg: number,
  radiusKm: number,
  steps = 16,
): [number, number][] {
  const ring: [number, number][] = [[lng, lat]];
  const sweep = ((endDeg - startDeg) % 360 + 360) % 360;
  for (let i = 0; i <= steps; i++) {
    const angle = startDeg + (sweep * i) / steps;
    ring.push(destination(lat, lng, angle, radiusKm));
  }
  ring.push([lng, lat]);
  return ring;
}

export function buildWedgesGeoJSON(
  lat: number,
  lng: number,
  range: SunriseSunsetAzimuthRangeResult,
  radiusKm: number,
): { wedges: GeoJSON.FeatureCollection; labels: GeoJSON.FeatureCollection } {
  const wedgeFeatures: GeoJSON.Feature[] = [];
  const labelFeatures: GeoJSON.Feature[] = [];

  const labelRadiusKm = insideViewKm(radiusKm);

  if (range.sunrise) {
    const { minDeg, maxDeg, minDate, maxDate } = range.sunrise;
    wedgeFeatures.push({
      type: 'Feature',
      properties: { kind: 'sunrise' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildSectorPolygon(lat, lng, minDeg, maxDeg, radiusKm)],
      },
    });

    labelFeatures.push({
      type: 'Feature',
      properties: { label: fmtDateShort(minDate) },
      geometry: {
        type: 'Point',
        coordinates: destination(lat, lng, minDeg, labelRadiusKm),
      },
    });

    labelFeatures.push({
      type: 'Feature',
      properties: { label: fmtDateShort(maxDate) },
      geometry: {
        type: 'Point',
        coordinates: destination(lat, lng, maxDeg, labelRadiusKm),
      },
    });
  }

  if (range.sunset) {
    const { minDeg, maxDeg, minDate, maxDate } = range.sunset;
    wedgeFeatures.push({
      type: 'Feature',
      properties: { kind: 'sunset' },
      geometry: {
        type: 'Polygon',
        coordinates: [buildSectorPolygon(lat, lng, minDeg, maxDeg, radiusKm)],
      },
    });

    labelFeatures.push({
      type: 'Feature',
      properties: { label: fmtDateShort(minDate) },
      geometry: {
        type: 'Point',
        coordinates: destination(lat, lng, minDeg, labelRadiusKm),
      },
    });

    labelFeatures.push({
      type: 'Feature',
      properties: { label: fmtDateShort(maxDate) },
      geometry: {
        type: 'Point',
        coordinates: destination(lat, lng, maxDeg, labelRadiusKm),
      },
    });
  }

  return {
    wedges: { type: 'FeatureCollection', features: wedgeFeatures },
    labels: { type: 'FeatureCollection', features: labelFeatures },
  };
}

export function buildBestHitGeoJSON(
  lat: number,
  lng: number,
  bestHit: { time: Date; azimuthDeg: number } | undefined,
  distanceKm: number,
): GeoJSON.FeatureCollection {
  if (!bestHit) {
    return { type: 'FeatureCollection', features: [] };
  }
  const pos = destination(lat, lng, bestHit.azimuthDeg, insideViewKm(distanceKm) * 0.85);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          label: fmtDateShort(bestHit.time),
        },
        geometry: {
          type: 'Point',
          coordinates: pos,
        },
      },
    ],
  };
}

function buildSpotGeoJSON(lat: number, lng: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
      },
    ],
  };
}

export function buildSunRaysGeoJSON(
  lat: number,
  lng: number,
  lengthKm: number = DEFAULT_LINE_LENGTH_KM,
  date: Date = new Date(),
): GeoJSON.FeatureCollection {
  const rs = sunriseSunset(date, lat, lng);
  const features: GeoJSON.Feature[] = [];

  if (rs.sunrise) {
    features.push({
      type: 'Feature',
      properties: { kind: 'sunrise' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lng, lat],
          destination(lat, lng, rs.sunrise.azimuth, lengthKm),
        ],
      },
    });
  }

  if (rs.sunset) {
    features.push({
      type: 'Feature',
      properties: { kind: 'sunset' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lng, lat],
          destination(lat, lng, rs.sunset.azimuth, lengthKm),
        ],
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function readStoredBool(key: string, defaultVal: boolean): boolean {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return defaultVal;
    return val === 'true';
  } catch {
    return defaultVal;
  }
}

function writeStoredBool(key: string, val: boolean): void {
  try {
    localStorage.setItem(key, String(val));
  } catch {
    // Ignore storage errors in private browsing
  }
}

export default function BearingMiniMap({ lat, lng, bearingDeg, bestHit, onChange }: BearingMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const isDraggingRef = useRef(false);

  // Overlaid toggles persisted in localStorage: default 3D on, satellite off
  const [terrainOn, setTerrainOn] = useState(() => readStoredBool(STORAGE_KEY_3D, true));
  const [satelliteOn, setSatelliteOn] = useState(() => readStoredBool(STORAGE_KEY_SATELLITE, false));

  // Compute 365-day solar extreme range once per lat/lng
  const sunRange = useMemo(() => {
    return sunriseSunsetAzimuthRange(lat, lng, new Date(), 365);
  }, [lat, lng]);

  // Latest props/callbacks stored in refs for event listeners
  const latLngRef = useRef({ lat, lng });
  latLngRef.current = { lat, lng };

  const bearingDegRef = useRef(bearingDeg);
  bearingDegRef.current = bearingDeg;

  const bestHitRef = useRef(bestHit);
  bestHitRef.current = bestHit;

  const sunRangeRef = useRef(sunRange);
  sunRangeRef.current = sunRange;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const getLineLengthKm = (map: MlMap): number => {
    try {
      return computeRayLengthKm(latLngRef.current, map.getBounds());
    } catch {
      return DEFAULT_LINE_LENGTH_KM;
    }
  };

  const updateMapSources = (map: MlMap) => {
    const lengthKm = getLineLengthKm(map);

    // 1. Wedges & labels
    const { wedges, labels } = buildWedgesGeoJSON(latLngRef.current.lat, latLngRef.current.lng, sunRangeRef.current, lengthKm);
    const wedgesSrc = map.getSource(SOURCE_WEDGES) as GeoJSONSource | undefined;
    if (wedgesSrc) wedgesSrc.setData(wedges);

    const labelsSrc = map.getSource(SOURCE_WEDGES_LABELS) as GeoJSONSource | undefined;
    if (labelsSrc) labelsSrc.setData(labels);

    // 2. Rays
    const raysSrc = map.getSource(SOURCE_SUN_RAYS) as GeoJSONSource | undefined;
    if (raysSrc) {
      raysSrc.setData(buildSunRaysGeoJSON(latLngRef.current.lat, latLngRef.current.lng, lengthKm));
    }

    // 3. Bearing line
    const bearingSrc = map.getSource(SOURCE_BEARING) as GeoJSONSource | undefined;
    if (bearingSrc) {
      bearingSrc.setData(selectedBearingProjectionGeoJSON(latLngRef.current, bearingDegRef.current, lengthKm));
    }

    // 4. Best hit marker
    const bestHitSrc = map.getSource(SOURCE_BEST_HIT) as GeoJSONSource | undefined;
    if (bestHitSrc) {
      bestHitSrc.setData(buildBestHitGeoJSON(latLngRef.current.lat, latLngRef.current.lng, bestHitRef.current, lengthKm));
    }

    // 5. Spot dot
    const spotSrc = map.getSource(SOURCE_SPOT) as GeoJSONSource | undefined;
    if (spotSrc) {
      spotSrc.setData(buildSpotGeoJSON(latLngRef.current.lat, latLngRef.current.lng));
    }
  };

  const applyTerrainMode = (map: MlMap, on: boolean) => {
    map.setTerrain(on ? { source: 'terrain', exaggeration: 1.4 } : null);
    map.easeTo({ pitch: on ? 55 : 0, bearing: 0, duration: 400 });
  };

  const applySatelliteMode = (map: MlMap, on: boolean) => {
    if (map.getLayer('imagery')) {
      map.setLayoutProperty('imagery', 'visibility', on ? 'visible' : 'none');
    }
  };

  // Initialise map
  useEffect(() => {
    if (!containerRef.current) return;

    const initial3d = readStoredBool(STORAGE_KEY_3D, true);
    const initialSat = readStoredBool(STORAGE_KEY_SATELLITE, false);

    const map = new MlMap({
      container: containerRef.current,
      style: STYLE_URL,
      center: [lng, lat],
      zoom: 15,
      pitch: initial3d ? 55 : 0,
      bearing: 0,
      interactive: false,
      attributionControl: false,
    });

    // Compact attribution; MapLibre opens it on first render, so collapse it to just the info icon.
    map.addControl(new AttributionControl({ compact: true }));
    map.once('idle', () => containerRef.current?.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));

    mapRef.current = map;

    map.on('load', () => {
      // Find style insertion anchor before adding base extra layers
      const layers = map.getStyle().layers ?? [];
      const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
      const firstRoad = layers.find((l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'transportation')?.id ?? firstSymbol;

      // 1. Satellite imagery layer (ESRI World Imagery), hidden by default
      if (!map.getSource('imagery')) {
        map.addSource('imagery', {
          type: 'raster',
          tiles: [ESRI],
          tileSize: 256,
          maxzoom: 17,
          attribution: 'Imagery © Esri',
        });
      }
      if (!map.getLayer('imagery')) {
        map.addLayer(
          {
            id: 'imagery',
            type: 'raster',
            source: 'imagery',
            layout: { visibility: initialSat ? 'visible' : 'none' },
          },
          firstRoad,
        );
      }

      // 2. DEM and hillshade layers for terrain
      if (!map.getSource('dem')) {
        map.addSource('dem', DEM_SOURCE);
      }
      if (!map.getSource('terrain')) {
        map.addSource('terrain', DEM_SOURCE);
      }
      if (!map.getLayer('hillshade')) {
        map.addLayer(
          {
            id: 'hillshade',
            type: 'hillshade',
            source: 'dem',
            paint: {
              'hillshade-illumination-anchor': 'map',
              'hillshade-method': 'combined',
              'hillshade-exaggeration': 0.5,
            },
          },
          firstRoad,
        );
      }

      // 3. 3D buildings: ensure style's fill-extrusion layers are visible
      for (const buildingId of buildingLayerIds(map)) {
        if (map.getLayer(buildingId)) {
          map.setLayoutProperty(buildingId, 'visibility', 'visible');
        }
      }

      // Apply initial 3D terrain and pitch
      if (initial3d) {
        map.setTerrain({ source: 'terrain', exaggeration: 1.4 });
        map.setPitch(55);
      }

      const initialLengthKm = getLineLengthKm(map);

      // --- OVERLAYS: Added ON TOP of satellite and buildings ---

      // 4. Sunrise / Sunset range wedges
      const { wedges, labels } = buildWedgesGeoJSON(latLngRef.current.lat, latLngRef.current.lng, sunRangeRef.current, initialLengthKm);
      map.addSource(SOURCE_WEDGES, { type: 'geojson', data: wedges });
      map.addLayer({
        id: `${SOURCE_WEDGES}-fill`,
        type: 'fill',
        source: SOURCE_WEDGES,
        paint: {
          'fill-color': [
            'match',
            ['get', 'kind'],
            'sunrise',
            '#f59e0b',
            '#fb923c',
          ],
          'fill-opacity': 0.18,
        },
      });
      map.addLayer({
        id: `${SOURCE_WEDGES}-line`,
        type: 'line',
        source: SOURCE_WEDGES,
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'sunrise',
            '#f59e0b',
            '#fb923c',
          ],
          'line-width': 1,
          'line-opacity': 0.35,
        },
      });

      // Solstice date labels at wedge edges
      map.addSource(SOURCE_WEDGES_LABELS, { type: 'geojson', data: labels });
      map.addLayer({
        id: SOURCE_WEDGES_LABELS,
        type: 'symbol',
        source: SOURCE_WEDGES_LABELS,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': FONT,
          'text-size': 10,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#e9ecf3',
          'text-halo-color': '#0e1014',
          'text-halo-width': 1.5,
        },
      });

      // 5. Sun reference rays (sunrise/sunset today) with dark casing
      map.addSource(SOURCE_SUN_RAYS, {
        type: 'geojson',
        data: buildSunRaysGeoJSON(latLngRef.current.lat, latLngRef.current.lng, initialLengthKm),
      });
      // Dark casing for rays
      map.addLayer({
        id: `${SOURCE_SUN_RAYS}-casing`,
        type: 'line',
        source: SOURCE_SUN_RAYS,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#0e1014',
          'line-width': 4.5,
          'line-opacity': 0.75,
        },
      });
      // Main rays line
      map.addLayer({
        id: SOURCE_SUN_RAYS,
        type: 'line',
        source: SOURCE_SUN_RAYS,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'sunrise',
            '#ffb03a',
            '#ff5537',
          ],
          'line-width': 2.5,
          'line-opacity': 0.95,
          'line-dasharray': [2, 2],
        },
      });

      // 6. Selected bearing projection line with white casing underneath
      map.addSource(SOURCE_BEARING, {
        type: 'geojson',
        data: selectedBearingProjectionGeoJSON(
          latLngRef.current,
          bearingDegRef.current,
          initialLengthKm,
        ),
      });
      // Casing layer: wider, white, ~0.9 opacity
      map.addLayer({
        id: `${SOURCE_BEARING}-casing`,
        type: 'line',
        source: SOURCE_BEARING,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 6.5,
          'line-opacity': 0.9,
        },
      });
      // Main bearing line: thicker, bold pink
      map.addLayer({
        id: SOURCE_BEARING,
        type: 'line',
        source: SOURCE_BEARING,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#ff2bd6',
          'line-width': 4.5,
          'line-opacity': 1.0,
        },
      });

      // 7. Best match marker along its azimuth near edge with date label
      map.addSource(SOURCE_BEST_HIT, {
        type: 'geojson',
        data: buildBestHitGeoJSON(latLngRef.current.lat, latLngRef.current.lng, bestHitRef.current, initialLengthKm),
      });
      map.addLayer({
        id: `${SOURCE_BEST_HIT}-dot`,
        type: 'circle',
        source: SOURCE_BEST_HIT,
        paint: {
          'circle-radius': 5,
          'circle-color': '#22c55e',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: `${SOURCE_BEST_HIT}-label`,
        type: 'symbol',
        source: SOURCE_BEST_HIT,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': FONT,
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0e1014',
          'text-halo-width': 1.5,
        },
      });

      // 8. Dot at the spot with white ring
      map.addSource(SOURCE_SPOT, {
        type: 'geojson',
        data: buildSpotGeoJSON(latLngRef.current.lat, latLngRef.current.lng),
      });
      map.addLayer({
        id: `${SOURCE_SPOT}-ring`,
        type: 'circle',
        source: SOURCE_SPOT,
        paint: {
          'circle-radius': 7.5,
          'circle-color': 'transparent',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: SOURCE_SPOT,
        type: 'circle',
        source: SOURCE_SPOT,
        paint: {
          'circle-radius': 5,
          'circle-color': '#f5a623',
          'circle-stroke-color': '#0e1014',
          'circle-stroke-width': 1.5,
        },
      });
    });

    const onResize = () => {
      updateMapSources(map);
    };
    map.on('resize', onResize);

    return () => {
      map.off('resize', onResize);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update center and lines when lat/lng change without recreating map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setCenter([lng, lat]);
    updateMapSources(map);
  }, [lat, lng, sunRange]);

  // Update bearing line when bearingDeg changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const lengthKm = getLineLengthKm(map);
    const bearingSrc = map.getSource(SOURCE_BEARING) as GeoJSONSource | undefined;
    if (bearingSrc) {
      bearingSrc.setData(selectedBearingProjectionGeoJSON({ lat, lng }, bearingDeg, lengthKm));
    }
  }, [bearingDeg, lat, lng]);

  // Update best hit marker when bestHit changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const lengthKm = getLineLengthKm(map);
    const bestHitSrc = map.getSource(SOURCE_BEST_HIT) as GeoJSONSource | undefined;
    if (bestHitSrc) {
      bestHitSrc.setData(buildBestHitGeoJSON(lat, lng, bestHit, lengthKm));
    }
  }, [bestHit, lat, lng]);

  // Handle 3D terrain toggle
  const toggleTerrain = () => {
    setTerrainOn((prev) => {
      const next = !prev;
      writeStoredBool(STORAGE_KEY_3D, next);
      const map = mapRef.current;
      if (map) {
        applyTerrainMode(map, next);
      }
      return next;
    });
  };

  // Handle satellite toggle
  const toggleSatellite = () => {
    setSatelliteOn((prev) => {
      const next = !prev;
      writeStoredBool(STORAGE_KEY_SATELLITE, next);
      const map = mapRef.current;
      if (map) {
        applySatelliteMode(map, next);
      }
      return next;
    });
  };

  // Handle pointer interactions (using map.unproject for geographic bearing in 3D/pitch)
  const handlePointerAt = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;

    const rect = container.getBoundingClientRect();
    const pointerPos = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
    const lngLat = map.unproject([pointerPos.x, pointerPos.y]);
    const deg = pointCoordToBearing(latLngRef.current, { lat: lngLat.lat, lng: lngLat.lng });
    onChangeRef.current(deg);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    handlePointerAt(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    handlePointerAt(e.clientX, e.clientY);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = nudgeBearing(bearingDegRef.current, e.key, e.shiftKey);
      if (next != null) {
        onChangeRef.current(next);
      }
    }
  };

  const stopControlPropagation = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      ref={containerRef}
      className="bearing-minimap"
      tabIndex={0}
      role="application"
      aria-label="Sun bearing map, drag or use arrow keys"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div
        className="bearing-minimap__controls"
        onPointerDown={stopControlPropagation}
        onPointerMove={stopControlPropagation}
        onPointerUp={stopControlPropagation}
        onClick={stopControlPropagation}
      >
        <button
          type="button"
          className={`chip chip--mini${terrainOn ? ' active' : ''}`}
          onClick={toggleTerrain}
          aria-pressed={terrainOn}
        >
          3D
        </button>
        <button
          type="button"
          className={`chip chip--mini${satelliteOn ? ' active' : ''}`}
          onClick={toggleSatellite}
          aria-pressed={satelliteOn}
        >
          Satellite
        </button>
      </div>
    </div>
  );
}
