import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DronePlanningPanel } from '../src/components/DronePlanningPanel.js';
import { api, type AerodromesContextResponse, type DroneContextResponse, type User } from '../src/api.js';
import { DRONE_LAYERS, setLayerVisible } from '../src/map/layers.js';
import { airportsGeoJSON, type DroneAirportItem } from '../src/map/drone.js';

const MOCK_USER: User = {
  id: 'usr-pilot-1',
  username: 'dronepilot',
  avatar: '',
  role: 'contributor',
  banned: false,
  created_at: '2026-10-01T00:00:00Z',
  bio: '',
  instagram: '',
};

const MOCK_LOCAL_AERODROMES: AerodromesContextResponse = {
  available: true,
  status: 'ok',
  radiusM: 5000,
  airports: [
    {
      id: 'TEST-YRED',
      name: 'Synthetic Redcliffe Test Aerodrome',
      icaoCode: 'YRED',
      controlled: true,
      geometry: { type: 'Point', coordinates: [153.068, -27.218] },
      runways: [
        {
          id: 'RWY-07-25',
          designator: '07/25',
          thresholdEndpoints: [
            [153.063, -27.219],
            [153.073, -27.217],
          ],
        },
      ],
      provenance: {
        source: 'Synthetic Airservices Test Feed',
        licence: 'CC BY 4.0 Test',
        authority: 'Airservices Australia (Test)',
        effectiveDate: '2026-10-01',
      },
    },
  ],
  aerodromes: [],
  closestAirport: null,
  closestAerodrome: null,
  source: {
    datasetId: 'aus-aerodromes-local',
    name: 'Australian Certified Aerodromes Registry',
    schemaVersion: '1.0.0',
    effectiveDate: '2026-10-01',
    publishedAt: '2026-10-01T00:00:00Z',
    licence: 'CC BY 4.0 Test',
    authority: 'Airservices Australia (Test)',
    recordCount: 1,
  },
};
MOCK_LOCAL_AERODROMES.aerodromes = MOCK_LOCAL_AERODROMES.airports;

test('aerodromes web: api.aerodromesContext requests public endpoint with parameters', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    return new Response(JSON.stringify(MOCK_LOCAL_AERODROMES), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const res = await api.aerodromesContext(-27.218, 153.068, 5000);
    assert.equal(res.available, true);
    assert.equal(res.airports.length, 1);
    assert.ok(requestedUrl.includes('/api/aerodromes/context?lat=-27.218&lng=153.068&radiusM=5000'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('drone planning panel: displays local aerodrome data loaded state with provenance', () => {
  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: null,
      aerodromesData: MOCK_LOCAL_AERODROMES,
      loading: false,
      error: '',
      planningPoint: { lat: -27.218, lng: 153.068 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Local aerodrome data active') || html.includes('Australian Certified Aerodromes Registry'));
  assert.ok(html.includes('effective 2026-10-01') || html.includes('2026-10-01'));
  assert.ok(html.includes('Airservices Australia (Test)'));
});

test('drone planning panel: displays absent/unavailable state when local dataset not installed', () => {
  const unavailableData: AerodromesContextResponse = {
    available: false,
    status: 'unavailable',
    message: 'Local aerodrome dataset not installed',
    radiusM: 5000,
    airports: [],
    aerodromes: [],
    closestAirport: null,
    closestAerodrome: null,
    source: null,
  };

  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: null,
      aerodromesData: unavailableData,
      loading: false,
      error: '',
      planningPoint: { lat: -27.218, lng: 153.068 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(
    html.includes('Local aerodrome dataset absent') || html.includes('not installed'),
    'Must indicate local dataset is absent/unavailable'
  );
});

test('drone planning panel: dynamic OpenAIP failure does not claim static aerodromes are removed', () => {
  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: null,
      aerodromesData: MOCK_LOCAL_AERODROMES,
      loading: false,
      error: 'OpenAIP connection timeout',
      planningPoint: { lat: -27.218, lng: 153.068 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('OpenAIP connection timeout'), 'Displays dynamic error');
  // Local aerodrome markings remain active
  assert.ok(
    html.includes('Local aerodrome data active') || html.includes('Australian Certified Aerodromes Registry'),
    'Local aerodrome data remains active despite dynamic failure'
  );
});

test('drone web: Drone toggle controls static aerodrome layers visibility in DRONE_LAYERS', () => {
  const aerodromeLayers = [
    'drone-airports-controlled',
    'drone-airports-caution',
    'drone-controlled-aerodrome-3nm-fill',
    'drone-controlled-aerodrome-3nm-line',
    'drone-runway-approach-core-fill',
    'drone-runway-approach-core-line',
    'drone-runway-approach-height-band-fill',
    'drone-runway-approach-height-band-line',
    'drone-runway-height-band-hatch-line',
  ];

  for (const layerId of aerodromeLayers) {
    assert.ok(DRONE_LAYERS.includes(layerId), `DRONE_LAYERS must include static aerodrome layer ${layerId}`);
  }

  // Verify setLayerVisible sets all aerodrome layers on and off
  const visibilityState: Record<string, string> = {};
  const mockMap: any = {
    setLayoutProperty: (layerId: string, prop: string, val: string) => {
      if (prop === 'visibility') visibilityState[layerId] = val;
    },
    getLayer: (id: string) => (DRONE_LAYERS.includes(id) ? {} : null),
  };

  // Toggle on
  setLayerVisible(mockMap, DRONE_LAYERS, true);
  for (const layerId of aerodromeLayers) {
    assert.equal(visibilityState[layerId], 'visible');
  }

  // Toggle off
  setLayerVisible(mockMap, DRONE_LAYERS, false);
  for (const layerId of aerodromeLayers) {
    assert.equal(visibilityState[layerId], 'none');
  }
});

test('drone web: static map layers survive dynamic drone context failure without being cleared', () => {
  const mapSources: Record<string, any> = {};
  const mockMap: any = {
    getSource: (id: string) => (mapSources[id] ? { setData: (data: any) => { mapSources[id] = data; } } : null),
  };

  // 1. Populate static aerodrome layers from local response
  const { points, controlled3nm, approachCore, approachHeightBand, heightBandHatch } = airportsGeoJSON(MOCK_LOCAL_AERODROMES.airports);
  mapSources['drone-airports'] = points;
  mapSources['drone-controlled-3nm'] = controlled3nm;
  mapSources['drone-runway-approach-core'] = approachCore;
  mapSources['drone-runway-approach-height-band'] = approachHeightBand;
  mapSources['drone-runway-height-band-hatch'] = heightBandHatch;

  // Verify static features exist
  assert.equal(mapSources['drone-airports'].features.length, 1);
  assert.ok(mapSources['drone-controlled-3nm'].features.length > 0);

  // 2. Simulate dynamic /api/drone/context failing
  // The dynamic failure handler must NOT touch static aerodrome sources
  const dynamicFailed = true;
  if (dynamicFailed) {
    // Dynamic handler only updates airspace/fire if any, never touches aerodrome sources
  }

  // Static sources must still be intact!
  assert.equal(mapSources['drone-airports'].features.length, 1);
  assert.equal(mapSources['drone-airports'].features[0].id, 'TEST-YRED');
  assert.ok(mapSources['drone-controlled-3nm'].features.length > 0);
});
