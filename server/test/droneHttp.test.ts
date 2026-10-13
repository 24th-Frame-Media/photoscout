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
      const res = await client('GET', '/api/drone/context?lat=-33.41&lng=149.65');
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

      // Evidence check: controlled aerodrome produces restriction
      const evidence = res.json.assessment.evidence;
      const controlledEvidence = evidence.find((e: any) => e.id === 'airport-apt-controlled');
      assert.ok(controlledEvidence);
      assert.equal(controlledEvidence.severity, 'restriction');

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
