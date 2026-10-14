export interface DroneAirspaceItem {
  id: string;
  name: string;
  type?: number | string;
  typeName?: string;
  icaoClass?: string;
  activity?: number | string;
  lowerLimit?: {
    value: number;
    unit?: string | number;
    referenceDatum?: string | number;
  };
  upperLimit?: {
    value: number;
    unit?: string | number;
    referenceDatum?: string | number;
  };
  geometry: GeoJSON.Geometry;
}

export interface DroneAirportItem {
  id: string;
  name: string;
  icaoCode?: string;
  iataCode?: string;
  type?: number | string;
  typeName?: string;
  controlled?: boolean;
  geometry: GeoJSON.Point;
  controlledBuffer?: GeoJSON.Geometry;
  distanceM?: number;
  outsidePlannedRadius?: boolean;
  runways?: Array<{
    designator?: string;
    surface?: string | number;
    lengthM?: number;
  }>;
  frequencies?: Array<{
    type?: string;
    frequency?: string;
    name?: string;
  }>;
}

export interface DroneFireHazardItem {
  id: string;
  title: string;
  category: string;
  status: string;
  sizeHa?: number;
  updated: string;
  link?: string;
  sourceGeometry: GeoJSON.Geometry;
  bufferGeometry: GeoJSON.Geometry;
  bufferMetres: number;
  bufferPolicyId: string;
  disclaimer: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatLimit(limit?: {
  value: number;
  unit?: string | number;
  referenceDatum?: string | number;
}): string {
  if (!limit) return 'Unknown';
  if (limit.value === 0 && (limit.referenceDatum === 0 || limit.referenceDatum === 'GND')) {
    return 'GND';
  }
  const unit = typeof limit.unit === 'string' ? limit.unit : 'ft';
  const datum = limit.referenceDatum ? ` ${limit.referenceDatum}` : '';
  return `${limit.value} ${unit}${datum}`.trim();
}

export function airspacesGeoJSON(
  airspaces: DroneAirspaceItem[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const as of airspaces) {
    if (!as.geometry) continue;

    const tn = (as.typeName || '').toUpperCase();
    let kind: 'prohibited' | 'restricted' | 'controlled' | 'caution' = 'caution';
    if (as.type === 3 || tn === 'PROHIBITED') {
      kind = 'prohibited';
    } else if (as.type === 1 || tn === 'RESTRICTED') {
      kind = 'restricted';
    } else if (
      as.type === 4 ||
      tn === 'CTR' ||
      tn === 'CTA' ||
      tn === 'TMA'
    ) {
      kind = 'controlled';
    }

    const lower = formatLimit(as.lowerLimit);
    const upper = formatLimit(as.upperLimit);

    features.push({
      type: 'Feature',
      id: as.id,
      properties: {
        id: as.id,
        name: as.name,
        typeName: as.typeName || 'AIRSPACE',
        kind,
        icaoClass: as.icaoClass,
        lowerLimitText: lower,
        upperLimitText: upper,
      },
      geometry: as.geometry,
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Generates a GeoJSON FeatureCollection containing a circular polygon representing
 * the planned flight radius centered at [lng, lat].
 */
export function flightRadiusGeoJSON(
  lat: number,
  lng: number,
  radiusKm: number,
  points = 64
): GeoJSON.FeatureCollection {
  const coords: Array<[number, number]> = [];
  const radiusM = radiusKm * 1000;
  const dByR = radiusM / 6371000;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;

  for (let i = 0; i <= points; i++) {
    const bearing = (i * 2 * Math.PI) / points;
    const pLatRad = Math.asin(
      Math.sin(latRad) * Math.cos(dByR) +
      Math.cos(latRad) * Math.sin(dByR) * Math.cos(bearing)
    );
    const pLngRad =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(dByR) * Math.cos(latRad),
        Math.cos(dByR) - Math.sin(latRad) * Math.sin(pLatRad)
      );
    coords.push([(pLngRad * 180) / Math.PI, (pLatRad * 180) / Math.PI]);
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'drone-flight-radius-circle',
        properties: {
          kind: 'planning-radius',
          radiusKm,
          radiusM,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [coords],
        },
      },
    ],
  };
}

export function airportsGeoJSON(airports: DroneAirportItem[]): {
  points: GeoJSON.FeatureCollection;
  controlled3nm: GeoJSON.FeatureCollection;
} {
  const pointFeatures: GeoJSON.Feature[] = [];
  const bufferFeatures: GeoJSON.Feature[] = [];

  for (const apt of airports) {
    if (!apt.geometry) continue;

    const isControlled = apt.controlled === true;

    pointFeatures.push({
      type: 'Feature',
      id: apt.id,
      properties: {
        id: apt.id,
        name: apt.name,
        icaoCode: apt.icaoCode,
        controlled: isControlled,
        outsidePlannedRadius: Boolean(apt.outsidePlannedRadius),
        distanceM: apt.distanceM,
        typeName: apt.typeName || (isControlled ? 'Controlled Aerodrome' : 'Aerodrome'),
      },
      geometry: apt.geometry,
    });

    if (isControlled && apt.controlledBuffer) {
      bufferFeatures.push({
        type: 'Feature',
        id: `${apt.id}-3nm`,
        properties: {
          airportId: apt.id,
          airportName: apt.name,
          icaoCode: apt.icaoCode,
          rule: 'CASR 101.238(d)(v)',
          sourceClassificationVerified: true,
          disclaimer:
            'Controlled aerodrome 3 NM conditional planning buffer (CASR 101.238(d)(v)). Conditions depend on aircraft category, weight (including 250 g threshold), and applicable permissions.',
        },
        geometry: apt.controlledBuffer,
      });
    }
  }

  return {
    points: { type: 'FeatureCollection', features: pointFeatures },
    controlled3nm: { type: 'FeatureCollection', features: bufferFeatures },
  };
}

export function droneFireHazardsGeoJSON(
  hazards: DroneFireHazardItem[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const h of hazards) {
    if (!h.bufferGeometry) continue;

    features.push({
      type: 'Feature',
      id: h.id,
      properties: {
        id: h.id,
        title: h.title,
        category: h.category,
        status: h.status,
        bufferMetres: h.bufferMetres,
        bufferPolicyId: h.bufferPolicyId,
        disclaimer: h.disclaimer,
        rule: 'CASR 101.238(e)',
      },
      geometry: h.bufferGeometry,
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

export function formatAirspaceDetail(props: Record<string, unknown>): string {
  const name = escapeHtml(String(props.name || 'Airspace'));
  const typeName = escapeHtml(String(props.typeName || ''));
  const lower = escapeHtml(String(props.lowerLimitText || ''));
  const upper = escapeHtml(String(props.upperLimitText || ''));

  return `<div class="drone-popup">
    <strong>${name}</strong> (${typeName})<br />
    <span>Limits: ${lower} to ${upper}</span><br />
    <em>Advisory context — verify active status with official aviation publications.</em>
  </div>`;
}

export function formatAirportDetail(props: Record<string, unknown>): string {
  const name = escapeHtml(String(props.name || 'Aerodrome'));
  const icao = props.icaoCode ? ` (${escapeHtml(String(props.icaoCode))})` : '';
  const isControlled = props.controlled === true;
  const isOutside = props.outsidePlannedRadius === true;
  const outsideNote = isOutside
    ? '<span class="drone-popup-alert">Outside selected planned flight radius</span><br />'
    : '';

  if (isControlled) {
    return `<div class="drone-popup">
      <strong>${name}${icao}</strong><br />
      ${outsideNote}<span class="drone-popup-alert">Verified Controlled Aerodrome (CASR 101.238(d)(v))</span><br />
      <em>3 NM conditional planning buffer shown. Conditions depend on aircraft category/weight (including 250 g threshold) and permissions. Confirm applicable CASA conditions before flight.</em>
    </div>`;
  }

  return `<div class="drone-popup">
    <strong>${name}${icao}</strong><br />
    ${outsideNote}<span>Aerodrome / landing area context</span><br />
    <em>Check for aircraft movements and approach/departure corridors before flight.</em>
  </div>`;
}

export function formatControlled3nmDetail(props: Record<string, unknown>): string {
  const name = escapeHtml(String(props.airportName || props.name || 'Controlled Aerodrome'));
  const icao = props.icaoCode ? ` (${escapeHtml(String(props.icaoCode))})` : '';
  const disclaimer = escapeHtml(
    String(
      props.disclaimer ||
        'Controlled aerodrome 3 NM conditional planning buffer (CASR 101.238(d)(v)).'
    )
  );

  return `<div class="drone-popup">
    <strong>${name}${icao} — 3 NM Buffer</strong><br />
    <span class="drone-popup-alert">${disclaimer}</span><br />
    <em>Conditional planning buffer: conditions depend on aircraft category/weight (including 250 g threshold) and permissions. Confirm applicable CASA conditions before flight.</em>
  </div>`;
}

export function formatFireHazardDetail(props: Record<string, unknown>): string {
  const title = escapeHtml(String(props.title || 'Fire Operation'));
  const category = escapeHtml(String(props.category || ''));
  const status = escapeHtml(String(props.status || ''));
  const disclaimer = escapeHtml(String(props.disclaimer || 'Modelled fire-operation hazard buffer.'));

  return `<div class="drone-popup">
    <strong>${title}</strong><br />
    <span>Alert: ${category} | Status: ${status}</span><br />
    <span class="drone-popup-alert">${disclaimer}</span><br />
    <em>CASR 101.238(e) restricts flight over emergency operations without approval from the person in charge.</em>
  </div>`;
}
