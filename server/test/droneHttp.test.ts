import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type Client } from './httpHarness.js';
import { _setRfsCacheForTesting } from '../src/feeds/rfs.js';

const BANNED_WORDS = ['\\blegal\\b', '\\bsafe\\b', '\\bapproved\\b', '\\bcleared\\b', '\\bauthorised\\b'];

function assertNoBannedWords(text: string) {
  for (const pattern of BANNED_WORDS) {
    const re = new RegExp(pattern, 'i');
    assert.ok(!re.test(text), `Response contained banned word matching ${pattern}: "${text.slice(0, 300)}"`);
  }
}

test('drone http: requires sign-in', async () => {
  const harness = await startApp();
  try {
    const anon = harness.client();
    const res = await anon('GET', '/api/drone/context?lat=-33.42&lng=149.58');
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Sign in required');
  } finally {
    await harness.close();
  }
});

test('drone http: validates query bounds and parameters', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-val', name: 'Validator' });

    // Missing lat/lng
    const r1 = await client('GET', '/api/drone/context');
    assert.equal(r1.status, 400);

    // Invalid coordinates
    const r2 = await client('GET', '/api/drone/context?lat=120&lng=149.58');
    assert.equal(r2.status, 400);

    const r3 = await client('GET', '/api/drone/context?lat=-33.42&lng=200');
    assert.equal(r3.status, 400);

    // Excessive radius
    const r4 = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58&radiusM=100000');
    assert.equal(r4.status, 400);

    // Non-numeric radius
    const r5 = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58&radiusM=bad');
    assert.equal(r5.status, 400);
  } finally {
    await harness.close();
  }
});

test('drone http: user without OpenAIP key returns configured: false with no upstream call', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-no-key', name: 'NoKeyUser' });

    const res = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58&radiusM=10000');
    assert.equal(res.status, 200);
    assert.equal(res.json.configured, false);
    assert.ok(res.json.message.includes('not configured'));
    assert.deepEqual(res.json.airspaces, []);
    assert.deepEqual(res.json.airports, []);
    assert.ok(res.json.assessment);
    assert.ok(res.json.assessment.notChecked.length > 0);
    assert.ok(res.json.assessment.pilotChecklist.length > 0);
    assertNoBannedWords(JSON.stringify(res.json));
  } finally {
    await harness.close();
  }
});

test('drone http: key isolation ensures one user key is never used for another user', async () => {
  const harness = await startApp();
  try {
    const user1 = harness.client();
    await harness.signIn(user1, 'google', { id: 'user-1', name: 'UserOne' });

    const user2 = harness.client();
    await harness.signIn(user2, 'google', { id: 'user-2', name: 'UserTwo' });

    // Set mock OpenAIP key for user1 only
    const saveRes = await user1('PUT', '/api/user/api-keys/openaip', { apiKey: 'test-key-user1-openaip' });
    assert.equal(saveRes.status, 200);

    // Mock fetch for OpenAIP
    const realFetch = globalThis.fetch;
    let fetchedWithKey: string | null = null;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('api.core.openaip.net')) {
        const headers = init?.headers as Record<string, string> | undefined;
        fetchedWithKey = headers?.['x-openaip-api-key'] ?? null;
        return new Response(JSON.stringify({ items: [], totalPages: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(input, init);
    };

    try {
      // User1 request should use user1's key
      const res1 = await user1('GET', '/api/drone/context?lat=-33.42&lng=149.58');
      assert.equal(res1.status, 200);
      assert.equal(res1.json.configured, true);
      assert.equal(fetchedWithKey, 'test-key-user1-openaip');

      fetchedWithKey = null;

      // User2 request must NOT use user1's key and returns configured: false
      const res2 = await user2('GET', '/api/drone/context?lat=-33.42&lng=149.58');
      assert.equal(res2.status, 200);
      assert.equal(res2.json.configured, false);
      assert.equal(fetchedWithKey, null, 'User 2 must not trigger upstream fetch with User 1 key');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await harness.close();
  }
});

test('drone http: generates 3 NM buffer ONLY for positively verified controlled airports', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-controlled', name: 'ControlledTester' });
    await client('PUT', '/api/user/api-keys/openaip', { apiKey: 'test-controlled-openaip-key' });

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('api.core.openaip.net/api/airspaces')) {
        return new Response(JSON.stringify({ items: [], totalPages: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('api.core.openaip.net/api/airports')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                _id: 'apt-controlled',
                name: 'Bathurst Airport (Controlled)',
                icaoCode: 'YBTH',
                controlled: true,
                geometry: { type: 'Point', coordinates: [149.65, -33.41] },
              },
              {
                _id: 'apt-uncontrolled',
                name: 'Local Glider Strip (Uncontrolled)',
                controlled: false,
                geometry: { type: 'Point', coordinates: [149.70, -33.45] },
              },
              {
                _id: 'apt-unknown',
                name: 'Private Helipad (Unknown)',
                geometry: { type: 'Point', coordinates: [149.50, -33.35] },
              },
            ],
            totalPages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return realFetch(input, init);
    };

    try {
      const res = await client('GET', '/api/drone/context?lat=-33.41&lng=149.65&radiusM=20000');
      assert.equal(res.status, 200);
      assert.equal(res.json.configured, true);

      const airports = res.json.airports;
      assert.equal(airports.length, 3);

      const controlled = airports.find((a: any) => a.id === 'apt-controlled');
      const uncontrolled = airports.find((a: any) => a.id === 'apt-uncontrolled');
      const unknown = airports.find((a: any) => a.id === 'apt-unknown');

      // Controlled MUST have 3 NM buffer geometry
      assert.ok(controlled.controlledBuffer, 'controlled airport must have controlledBuffer');
      assert.equal(controlled.controlledBuffer.type, 'Polygon');
      assert.ok(controlled.controlledBuffer.coordinates[0].length >= 8);

      // Uncontrolled and Unknown MUST NOT have 3 NM buffer geometry
      assert.equal(uncontrolled.controlledBuffer, undefined);
      assert.equal(unknown.controlledBuffer, undefined);

      // Controlled aerodrome creates a conditional caution until the pilot has
      // supplied aircraft category/weight and approval facts.
      const evidence = res.json.assessment.evidence;
      const controlledEvidence = evidence.find((e: any) => e.id === 'airport-apt-controlled');
      assert.ok(controlledEvidence);
      assert.equal(controlledEvidence.severity, 'caution');
      assert.ok(String(controlledEvidence.explanation).includes('250 g'));

      const uncontrolledEvidence = evidence.find((e: any) => e.id === 'airport-apt-uncontrolled');
      assert.ok(uncontrolledEvidence);
      assert.equal(uncontrolledEvidence.severity, 'caution');

      assertNoBannedWords(JSON.stringify(res.json));
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await harness.close();
  }
});

test('drone http: integrates RFS fire hazards with 2 km modelled buffer and CASR 101.238(e)', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-fire', name: 'FireTester' });

    // Seed RFS cache with an active incident
    _setRfsCacheForTesting({
      at: Date.now(),
      data: [
        {
          id: 'fire-panorama',
          title: 'Mount Panorama Fire Operation',
          category: 'Watch and Act',
          status: 'Out of Control',
          updated: '2026-10-13T12:00:00Z',
          link: 'https://www.rfs.nsw.gov.au/incident/panorama',
          geometry: { type: 'Point', coordinates: [149.55, -33.45] },
        },
      ],
    });

    const res = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58');
    assert.equal(res.status, 200);

    const hazards = res.json.fireHazards;
    assert.equal(hazards.length, 1);
    assert.equal(hazards[0].id, 'fire-panorama');
    assert.equal(hazards[0].bufferMetres, 2000);
    assert.equal(hazards[0].bufferPolicyId, 'photoscout-fire-hazard-2km-v1');
    assert.equal(hazards[0].bufferGeometry.type, 'Polygon');
    assert.ok(hazards[0].disclaimer.includes('Modelled'));

    const fireEvidence = res.json.assessment.evidence.find((e: any) => e.id === 'fire-fire-panorama');
    assert.ok(fireEvidence);
    assert.equal(fireEvidence.severity, 'restriction');
    assert.equal(fireEvidence.ruleId, 'casr-101-238-e');
    assert.ok(fireEvidence.explanation.includes('CASR 101.238(e)'));
    assert.ok(fireEvidence.explanation.toLowerCase().includes('modelled'));
    assertNoBannedWords(JSON.stringify(res.json));
  } finally {
    _setRfsCacheForTesting(null);
    await harness.close();
  }
});

test('drone http: upstream provider errors do not leak secrets in responses', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-err', name: 'ErrorTester' });
    const secretKey = 'super-secret-openaip-token-xyz999';
    await client('PUT', '/api/user/api-keys/openaip', { apiKey: secretKey });

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('api.core.openaip.net')) {
        return new Response(JSON.stringify({ error: `Unauthorized key ${secretKey}` }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(input, init);
    };

    try {
      const res = await client('GET', '/api/drone/context?lat=-33.50&lng=149.80');
      assert.equal(res.status, 200);
      assert.equal(res.json.configured, true);
      const str = JSON.stringify(res.json);
      assert.ok(!str.includes(secretKey), 'Secret key must be completely redacted from response');
      assertNoBannedWords(str);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await harness.close();
  }
});

test('drone http: includes population, weather, and aircraft context, preserving NOTAM and emergency gates', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-ctx', name: 'ContextTester' });

    const res = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58');
    assert.equal(res.status, 200);

    // NOTAM and non-fire emergency gates must ALWAYS be present in notChecked
    const notChecked = res.json.assessment.notChecked;
    assert.ok(Array.isArray(notChecked));
    const notamGate = notChecked.find((e: any) => e.category === 'notam');
    const emergencyGate = notChecked.find((e: any) => e.category === 'emergency');
    assert.ok(notamGate, 'NOTAM gate must be present in notChecked');
    assert.ok(emergencyGate, 'Emergency gate must be present in notChecked');
    assert.equal(notamGate.severity, 'not_checked');
    assert.equal(emergencyGate.severity, 'not_checked');

    // Evidence must contain population, weather, and aircraft context items
    const evidence = res.json.assessment.evidence;
    const popEvidence = evidence.find((e: any) => e.category === 'population');
    const wxEvidence = evidence.find((e: any) => e.category === 'weather');
    const airEvidence = evidence.find((e: any) => e.category === 'aircraft');

    assert.ok(popEvidence, 'Population context evidence must be present');
    assert.ok(wxEvidence, 'Weather context evidence must be present');
    assert.ok(airEvidence, 'Aircraft context evidence must be present');

    assertNoBannedWords(JSON.stringify(res.json));
  } finally {
    await harness.close();
  }
});

test('drone http: defaults planned flight radius to 5 km (5000 m)', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-def-rad', name: 'DefRadiusTester' });

    const res = await client('GET', '/api/drone/context?lat=-33.42&lng=149.58');
    assert.equal(res.status, 200);
    assert.equal(res.json.radiusM, 5000, 'Must default planned flight radius to 5000 m (5 km)');
  } finally {
    await harness.close();
  }
});

test('drone http: filters airspaces and airports to planned radius, preserving 3 NM controlled buffer intersections', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-rad-scope', name: 'RadScopeTester' });
    await client('PUT', '/api/user/api-keys/openaip', { apiKey: 'test-scope-key' });

    const centerLat = -33.45;
    const centerLng = 149.55;

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('api.core.openaip.net/api/airspaces')) {
        return new Response(
          JSON.stringify({
            items: [
              // Airspace 1: inside 5 km circle (at ~1 km)
              {
                _id: 'as-inside',
                name: 'Inside Airspace',
                type: 1, // RESTRICTED
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [149.55, -33.44],
                      [149.57, -33.44],
                      [149.57, -33.46],
                      [149.55, -33.46],
                      [149.55, -33.44],
                    ],
                  ],
                },
              },
              // Airspace 2: outside 5 km circle (at ~11 km)
              {
                _id: 'as-outside',
                name: 'Outside Airspace',
                type: 1, // RESTRICTED
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [149.55, -33.34],
                      [149.57, -33.34],
                      [149.57, -33.36],
                      [149.55, -33.36],
                      [149.55, -33.34],
                    ],
                  ],
                },
              },
            ],
            totalPages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('api.core.openaip.net/api/airports')) {
        return new Response(
          JSON.stringify({
            items: [
              // Controlled airport at ~8 km: 3 NM (5556 m) buffer intersects 5 km circle!
              {
                _id: 'apt-ctrl-8km',
                name: 'Bathurst Controlled 8km',
                controlled: true,
                geometry: { type: 'Point', coordinates: [149.55, -33.378] },
              },
              // Uncontrolled airport at ~12 km: outside 5 km circle and does not intersect!
              {
                _id: 'apt-unctrl-12km',
                name: 'Far Glider Strip 12km',
                controlled: false,
                geometry: { type: 'Point', coordinates: [149.55, -33.342] },
              },
            ],
            totalPages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return realFetch(input, init);
    };

    try {
      const res = await client('GET', `/api/drone/context?lat=${centerLat}&lng=${centerLng}&radiusM=5000`);
      assert.equal(res.status, 200);

      // Airspaces: only 'as-inside' should be present
      assert.equal(res.json.airspaces.length, 1);
      assert.equal(res.json.airspaces[0].id, 'as-inside');

      // Airports: controlled at 8 km must be present due to 3 NM buffer intersection
      const airports = res.json.airports;
      const ctrl = airports.find((a: any) => a.id === 'apt-ctrl-8km');
      assert.ok(ctrl, 'Controlled airport with intersecting 3 NM buffer must be included');
      assert.ok(ctrl.controlledBuffer, 'Controlled airport must have controlledBuffer geometry');

      // Uncontrolled airport at 12 km should not be present
      const unctrl = airports.find((a: any) => a.id === 'apt-unctrl-12km');
      assert.equal(unctrl, undefined, 'Far uncontrolled airport outside radius must be excluded');

      // Evidence check: only planned area items
      const evidence = res.json.assessment.evidence;
      assert.ok(evidence.some((e: any) => e.id === 'airspace-as-inside'));
      assert.ok(!evidence.some((e: any) => e.id === 'airspace-as-outside'));
      assert.ok(evidence.some((e: any) => e.id === 'airport-apt-ctrl-8km'));
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await harness.close();
  }
});

test('drone http: always includes closest mapped airport when outside planned flight radius', async () => {
  const harness = await startApp();
  try {
    const client = harness.client();
    await harness.signIn(client, 'google', { id: 'user-closest-apt', name: 'ClosestAptTester' });
    await client('PUT', '/api/user/api-keys/openaip', { apiKey: 'test-closest-key' });

    const centerLat = -33.52;
    const centerLng = 149.48;

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('api.core.openaip.net/api/airspaces')) {
        return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
      }
      if (url.includes('api.core.openaip.net/api/airports')) {
        return new Response(
          JSON.stringify({
            items: [
              // Closest airport at ~8 km (outside 2 km radius)
              {
                _id: 'apt-orange-8km',
                name: 'Orange Airport',
                icaoCode: 'YORG',
                controlled: false,
                geometry: { type: 'Point', coordinates: [149.48, -33.448] },
              },
              // Farther airport at ~18 km
              {
                _id: 'apt-cowra-18km',
                name: 'Cowra Airport',
                icaoCode: 'YCWR',
                controlled: false,
                geometry: { type: 'Point', coordinates: [149.48, -33.358] },
              },
            ],
            totalPages: 1,
          }),
          { status: 200 }
        );
      }
      return realFetch(input, init);
    };

    try {
      // 2 km radius: all airports are outside!
      const res = await client('GET', `/api/drone/context?lat=${centerLat}&lng=${centerLng}&radiusM=2000`);
      assert.equal(res.status, 200);

      // Closest airport must be included and flagged outside planned radius
      const airports = res.json.airports;
      assert.equal(airports.length, 1);
      assert.equal(airports[0].id, 'apt-orange-8km');
      assert.equal(airports[0].outsidePlannedRadius, true);

      // In assessment evidence, it must be present and labeled as outside planned radius
      const evidence = res.json.assessment.evidence;
      const aptEvidence = evidence.find((e: any) => e.id === 'airport-apt-orange-8km');
      assert.ok(aptEvidence, 'Closest airport caution must be present in evidence');
      assert.ok(
        aptEvidence.title.toLowerCase().includes('outside planned radius') ||
        aptEvidence.explanation.toLowerCase().includes('outside planned'),
        'Evidence must clearly label airport as outside planned radius'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await harness.close();
  }
});
