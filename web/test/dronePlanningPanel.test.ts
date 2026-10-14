import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DronePlanningPanel } from '../src/components/DronePlanningPanel.js';
import type { DroneContextResponse, User } from '../src/api.js';

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

const MOCK_DATA: DroneContextResponse = {
  configured: true,
  airspaces: [],
  airports: [],
  fireHazards: [],
  weather: {
    windKmh: 18,
    gustKmh: 28,
    visibilityM: 10000,
    tempC: 22,
    cloudPct: 35,
  },
  aircraft: {
    count: 1,
    nearby: [{ hex: '7c1234', flight: 'QFA401', alt_baro: 3500 }],
  },
  assessment: {
    overallSeverity: 'caution',
    summary: 'Mapped caution identified — pilot risk assessment required',
    evaluatedAt: '2026-10-14T00:00:00Z',
    evidence: [
      {
        id: 'caution-weather',
        category: 'weather',
        severity: 'caution',
        authority: 'regulator_guidance',
        ruleId: 'casr-101-095',
        title: 'Weather conditions context',
        explanation: 'Forecast indicates wind 18 km/h with gusts to 28 km/h. Pilot must confirm daylight visual meteorological conditions before flight.',
        source: { name: 'Open-Meteo Weather', fetchedAt: '2026-10-14T00:00:00Z' },
        userAction: 'Confirm conditions are within manufacturer operating limits and CASR 101.095 daylight VMC.',
      },
      {
        id: 'caution-populous',
        category: 'population',
        severity: 'caution',
        authority: 'regulator_guidance',
        ruleId: 'casr-101-245',
        title: 'Likely people/property exposure',
        explanation: 'Environmental context indicates potential people or property exposure (12 buildings mapped in vicinity). Statutory populous-area manual assessment required by pilot.',
        source: { name: 'PhotoScout Population Heuristic' },
        userAction: 'Conduct on-site manual assessment of people, populous area risk, and maintain minimum 30 m separation.',
      },
      {
        id: 'airport-bathurst',
        category: 'airport',
        severity: 'caution',
        authority: 'legislation',
        ruleId: 'casr-101-075',
        title: 'Controlled aerodrome proximity: Bathurst Aerodrome',
        explanation: 'Verified controlled aerodrome (YBTH). A 3 NM planning buffer is shown because standard conditions can depend on aircraft category, including the 250 g threshold, and any applicable permission or exemption. Confirm the CASA condition that applies to this operation before flight.',
        source: { name: 'openAIP Core API', fetchedAt: '2026-10-13T23:00:00Z' },
        userAction: 'Confirm aircraft category/weight, approval status, and applicable controlled-aerodrome conditions before operating within 3 NM.',
      },
    ],
    notChecked: [
      {
        id: 'gate-notam',
        category: 'notam',
        severity: 'not_checked',
        authority: 'unknown',
        title: 'NOTAMs',
        explanation: 'Not checked — obtain current official aviation notices and temporary flight restrictions before flight.',
        source: { name: 'No authoritative provider configured' },
        userAction: 'Review official NAIPS / NOTAM briefing for tactical airspace activations.',
      },
      {
        id: 'gate-emergency',
        category: 'emergency',
        severity: 'not_checked',
        authority: 'unknown',
        title: 'Non-fire emergency operations',
        explanation: 'Not checked — emergency operations (police, search and rescue, disaster response) may be underway; confirm with local sources.',
        source: { name: 'No authoritative provider configured' },
        userAction: 'Check local emergency broadcaster and do not operate near active emergency scenes.',
      },
    ],
    pilotChecklist: [
      {
        id: 'checklist-vlos',
        category: 'operator',
        severity: 'pilot_responsibility',
        authority: 'legislation',
        ruleId: 'casr-101-073',
        title: 'Visual line of sight (VLOS)',
        explanation: 'The remote pilot must maintain direct visual contact with the RPA without visual aids other than corrective lenses.',
        source: { name: 'CASR 101.073' },
        userAction: 'Maintain direct unaided visual contact with aircraft throughout flight.',
      },
      {
        id: 'checklist-max-height',
        category: 'operator',
        severity: 'pilot_responsibility',
        authority: 'legislation',
        ruleId: 'casr-101-085',
        title: 'Maximum height (400 ft AGL / 120 m)',
        explanation: 'Standard RPA operations must remain at or below 400 ft (120 m) above ground level.',
        source: { name: 'CASR 101.085' },
        userAction: 'Plan flight ceiling strictly at or below 400 ft (120 m) above ground level.',
      },
      {
        id: 'checklist-separation',
        category: 'operator',
        severity: 'pilot_responsibility',
        authority: 'legislation',
        ruleId: 'casr-101-245',
        title: '30 m separation from uninvolved people',
        explanation: 'The remote pilot must maintain at least 30 metres horizontal separation from people not directly involved.',
        source: { name: 'CASR 101.245' },
        userAction: 'Establish and monitor minimum 30 m horizontal perimeter from uninvolved bystanders.',
      },
    ],
  },
  sources: {
    openaip: {
      provider: 'openAIP',
      endpoint: '/api/airspaces',
      fetchedAt: '2026-10-13T23:00:00Z',
      expiresAt: '2026-10-14T05:00:00Z',
      stale: false,
      attribution: 'Airspace data provided by openAIP (CC BY-NC-SA 4.0)',
    },
    rfs: {
      fetchedAt: '2026-10-14T00:00:00Z',
      stale: false,
      attribution: 'NSW Rural Fire Service (CC BY 4.0)',
    },
  },
};

test('drone planning panel: renders severity summary, evidence, NOTAM gates, and checklist in order', () => {
  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: MOCK_DATA,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  // 1. Severity summary
  assert.ok(html.includes('Mapped caution identified'), 'Must display assessment summary');
  assert.ok(html.includes('-33.42'), 'Must show planning coordinates');

  // 2. Mapped cautions / evidence
  assert.ok(html.includes('Weather conditions context'));
  assert.ok(html.includes('Likely people/property exposure'));
  assert.ok(html.includes('Controlled aerodrome proximity'));
  // Controlled aerodrome 3 NM must reflect conditional buffer
  assert.ok(html.includes('250 g'), 'Controlled aerodrome text must mention conditional 250 g / category threshold');

  // 3. Not checked gates must be clearly visible
  assert.ok(html.includes('NOTAMs'), 'NOTAMs gate must be visible');
  assert.ok(html.includes('Non-fire emergency operations'), 'Emergency operations gate must be visible');
  assert.ok(html.includes('No authoritative provider configured'), 'Must show unconfigured provider badge for NOTAMs');

  // 4. Pilot responsibility checklist
  assert.ok(html.includes('Visual line of sight (VLOS)'));
  assert.ok(html.includes('Maximum height (400 ft AGL / 120 m)'));
  assert.ok(html.includes('30 m separation from uninvolved people'));

  // 5. Sources and attribution
  assert.ok(html.includes('openAIP'));
  assert.ok(html.includes('CC BY-NC-SA 4.0'));

  // 6. Required disclaimer
  assert.ok(
    html.includes('Planning guidance only'),
    'Must include required planning guidance disclaimer'
  );
  assert.ok(
    html.includes('PhotoScout does not confirm that a flight is legal, authorised, or safe'),
    'Must include verbatim statutory disclaimer'
  );
});

test('drone planning panel: unauthenticated or unconfigured states show helpful guidance with links', () => {
  // Visitor with no user session
  const anonHtml = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: null,
      data: null,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );
  assert.ok(anonHtml.includes('Sign in'), 'Anon user must see sign in prompt');

  // User with no OpenAIP key configured
  const unconfiguredData: DroneContextResponse = {
    ...MOCK_DATA,
    configured: false,
    message: 'OpenAIP API key not configured. Add your API key in Settings -> API Keys.',
  };
  const unconfHtml = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: unconfiguredData,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );
  assert.ok(unconfHtml.includes('OpenAIP API key not configured') || unconfHtml.includes('Settings'));
  // Even when unconfigured, NOTAM gates and checklist remain visible
  assert.ok(unconfHtml.includes('NOTAMs'));
  assert.ok(unconfHtml.includes('Visual line of sight (VLOS)'));
});

test('drone planning panel: never claims safe, legal, approved, cleared, or authorised in conclusions', () => {
  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: MOCK_DATA,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  // Strip the explicit negative legal disclaimer which explicitly states "does not confirm that a flight is legal..."
  const contentWithoutDisclaimer = html.replace(/<section class="drone-disclaimer">[\s\S]*?<\/section>/, '');

  const BANNED_PATTERNS = [/\blegal\b/i, /\bsafe\b/i, /\bapproved\b/i, /\bcleared\b/i, /\bauthorised\b/i, /\bauthorized\b/i];
  for (const pat of BANNED_PATTERNS) {
    assert.ok(!pat.test(contentWithoutDisclaimer), `Panel HTML contained banned pattern ${pat}`);
  }
});

test('drone planning panel: renders accessible labelled planned flight radius slider defaulting to 5 km', () => {
  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: MOCK_DATA,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  // Accessible labelled slider for planned flight radius
  assert.ok(html.includes('type="range"'), 'Must include range slider input');
  assert.ok(html.includes('value="5"'), 'Slider must default to 5 km');
  assert.ok(html.includes('5 km'), 'Must display exact selected value in km');
  assert.ok(
    html.toLowerCase().includes('planned flight radius') || html.toLowerCase().includes('flight radius'),
    'Must include labelled flight radius title'
  );
  assert.ok(html.includes('min="1"'), 'Slider min bound must be 1 km');
  assert.ok(html.includes('max="50"'), 'Slider max bound must be 50 km within OpenAIP constraints');
});

test('drone planning panel: clearly labels closest airport as outside planned radius when applicable', () => {
  const outOfRadiusAirportData: DroneContextResponse = {
    ...MOCK_DATA,
    assessment: {
      ...MOCK_DATA.assessment!,
      evidence: [
        {
          id: 'airport-orange',
          category: 'airport',
          severity: 'caution',
          authority: 'legislation',
          ruleId: 'casr-101-075',
          title: 'Controlled aerodrome proximity (outside planned radius): Orange Airport',
          explanation: 'Closest mapped aerodrome in provider search area (8.4 km away, outside planned 5 km flight radius). Verified controlled aerodrome (YORG). 3 NM buffer does not intersect planned flight radius.',
          source: { name: 'openAIP Core API' },
          userAction: 'Advisory context: monitor for traffic if extending flight boundaries.',
        },
      ],
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: outOfRadiusAirportData,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('outside planned radius') || html.includes('Outside planned radius'), 'Must clearly label airport as outside planned radius');
  assert.ok(html.includes('Orange Airport'));
  assert.ok(html.includes('8.4 km'));
});

test('drone planning panel: shows closest ADS-B aircraft with incomplete coverage disclaimer, and handles zero aircraft visibility', () => {
  // Case A: Aircraft detected with closest aircraft details
  const aircraftData: DroneContextResponse = {
    ...MOCK_DATA,
    aircraft: {
      count: 2,
      closest: { hex: '7c1234', flight: 'QFA401', alt_baro: 3500, distanceM: 4200 },
      nearby: [
        { hex: '7c1234', flight: 'QFA401', alt_baro: 3500, distanceM: 4200 },
        { hex: '7c5678', flight: 'JST502', alt_baro: 8000, distanceM: 12000 },
      ],
    },
  };

  const htmlWithPlanes = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: aircraftData,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(htmlWithPlanes.includes('QFA401') || htmlWithPlanes.includes('7c1234'), 'Must show closest aircraft');
  assert.ok(htmlWithPlanes.includes('4.2 km') || htmlWithPlanes.includes('4 km'), 'Must show closest aircraft distance');
  assert.ok(htmlWithPlanes.includes('Incomplete ADS-B coverage'), 'Must retain incomplete coverage disclaimer');

  // Case B: Zero aircraft detected — must make that visible and never imply no aircraft exist
  const zeroAircraftData: DroneContextResponse = {
    ...MOCK_DATA,
    aircraft: {
      count: 0,
      nearby: [],
    },
  };

  const htmlZero = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: zeroAircraftData,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(
    htmlZero.includes('No broadcast aircraft') || htmlZero.includes('No broadcast ADS-B aircraft'),
    'Must make lack of broadcast aircraft visible'
  );
  assert.ok(htmlZero.includes('Incomplete ADS-B coverage') || htmlZero.includes('incomplete'), 'Must retain incomplete coverage disclaimer');
});

test('drone planning panel: shows runway geometry unavailable warning when controlled aerodrome lacks runways', () => {
  const missingRunwayData: DroneContextResponse = {
    ...MOCK_DATA,
    assessment: {
      ...MOCK_DATA.assessment!,
      evidence: [
        {
          id: 'airport-unavail',
          category: 'airport',
          severity: 'caution',
          authority: 'legislation',
          ruleId: 'casr-101-075',
          title: 'Controlled aerodrome proximity: Field Without Runways',
          explanation: 'Controlled aerodrome reported by provider within planned flight radius. Runway geometry unavailable — verify current aerodrome data; 3 NM centreline buffer not rendered. Under CASR 101.238(d)(v) and CASR 101 MOS Section 4.04/4.05, operations in controlled airspace or within 3 NM (5556 m) of a controlled aerodrome boundary have restricted flight permissions depending on aircraft weight (250 g threshold).',
          source: { name: 'openAIP Core API' },
          userAction: 'Verify aerodrome runway configuration and coordinates manually with official publications before flight.',
        },
      ],
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(DronePlanningPanel, {
      user: MOCK_USER,
      data: missingRunwayData,
      loading: false,
      error: '',
      planningPoint: { lat: -33.42, lng: 149.58 },
      radiusKm: 5,
      onChangeRadius: () => {},
      onSetPlanningPoint: () => {},
      onClose: () => {},
    })
  );

  assert.ok(
    html.includes('Runway geometry unavailable — verify current aerodrome data'),
    'Must display runway geometry unavailable warning'
  );
  assert.ok(html.includes('3 NM centreline buffer not rendered'));
});
