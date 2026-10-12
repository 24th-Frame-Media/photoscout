import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRouteSegments,
  routePlanAnchor,
  type RouteType,
  routingWaypoints,
  fetchOsrmFullRoute,
} from '../src/map/routeGeometry.js';

// --- Segment construction ---

test('buildRouteSegments: sprint produces N-1 ordered segments', () => {
  const v: [number, number][] = [[0, 0], [1, 0], [2, 1]];
  const segs = buildRouteSegments(v, 'sprint');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [[0, 0], [1, 0]]);
  assert.deepEqual(segs[1], [[1, 0], [2, 1]]);
});

test('buildRouteSegments: circuit appends closing leg last→first', () => {
  const v: [number, number][] = [[0, 0], [1, 0], [1, 1]];
  const segs = buildRouteSegments(v, 'circuit');
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[2], [[1, 1], [0, 0]]);
});

test('buildRouteSegments: circuit with 2 points closes back', () => {
  const v: [number, number][] = [[0, 0], [1, 1]];
  const segs = buildRouteSegments(v, 'circuit');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[1], [[1, 1], [0, 0]]);
});

test('buildRouteSegments: sprint with 1 vertex has zero segments', () => {
  assert.equal(buildRouteSegments([[0, 0]], 'sprint').length, 0);
});

test('buildRouteSegments: empty array yields no segments for either type', () => {
  assert.equal(buildRouteSegments([], 'sprint').length, 0);
  assert.equal(buildRouteSegments([], 'circuit').length, 0);
});

test('buildRouteSegments: circuit with 1 vertex yields no segments', () => {
  assert.equal(buildRouteSegments([[0, 0]], 'circuit').length, 0);
});

// --- Plan Shoot anchor ---

test('routePlanAnchor: prefers staging over first vertex', () => {
  const anchor = routePlanAnchor(
    [[151.2, -33.8], [151.3, -33.7]],
    { lat: -33.9, lng: 151.1 },
  );
  assert.deepEqual(anchor, { lat: -33.9, lng: 151.1 });
});

test('routePlanAnchor: falls back to first vertex lng/lat when no staging', () => {
  const anchor = routePlanAnchor([[151.2, -33.8], [151.3, -33.7]], null);
  // vertex is [lng, lat], anchor must be { lat, lng }
  assert.deepEqual(anchor, { lat: -33.8, lng: 151.2 });
});

test('routePlanAnchor: returns null with no staging and no vertices', () => {
  assert.equal(routePlanAnchor([], null), null);
});

test('routePlanAnchor: staging null with no vertices returns null', () => {
  assert.equal(routePlanAnchor([], null), null);
});

test('routeToDraft preserves saved geometry without treating endpoints as the full editable route', async () => {
  const { routeToDraft } = await import('../src/components/RouteEditor.js');
  const vertices = Array.from({ length: 20 }, (_, i) => [151 + i / 100, -33] as [number, number]);
  const draft = routeToDraft({
    id: 'route-1',
    ownerId: 'user-1',
    name: 'Long route',
    notes: '',
    access: '',
    type: 'sprint',
    vertices,
    staging: null,
    visibility: 'private',
    createdAt: '',
    updatedAt: '',
  });

  assert.deepEqual(draft.vertices, vertices);
  assert.equal(draft.waypoints, undefined);
  assert.equal(draft.snap, false);
});

test('route draft round trip keeps routed geometry, chosen stops, and road preference', async () => {
  const { routeToDraft, draftToRoute, blankRouteDraft } = await import('../src/components/RouteEditor.js');
  const route = {
    id: 'route-2', ownerId: 'user-1', name: 'Drive', notes: '', access: '',
    type: 'sprint' as const, vertices: [[151, -33], [151.1, -33.1], [151.2, -33.2]] as [number, number][],
    waypoints: [[151, -33], [151.2, -33.2]] as [number, number][], snap: true,
    staging: null, visibility: 'private' as const, createdAt: '', updatedAt: '',
  };
  const draft = routeToDraft(route);
  assert.deepEqual(draftToRoute(draft).vertices, route.vertices);
  assert.deepEqual(draftToRoute(draft).waypoints, route.waypoints);
  assert.equal(draftToRoute(draft).snap, true);
  assert.equal(blankRouteDraft().visibility, 'private');
});

// --- Distance & Telemetry ---

test('routeDistanceKm and formatDuration: compute distance and format time', async () => {
  const { routeDistanceKm, formatDuration } = await import('../src/map/routeGeometry.js');
  // Two points ~111 km apart (1 degree lat)
  const dist = routeDistanceKm([[0, 0], [0, 1]]);
  assert.ok(dist >= 110 && dist <= 112);
  assert.ok(formatDuration(6660).includes('h'));
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(75.6), '1m 16s');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0s');
});

// --- Stops & labels ---

test('reverseWaypoints flips stops; routeStops and stopLabel drive the list and markers', async () => {
  const { reverseWaypoints, routeStops, stopLabel } = await import('../src/map/routeGeometry.js');
  const pts: [number, number][] = [[1, 1], [2, 2], [3, 3]];
  assert.deepEqual(reverseWaypoints(pts), [[3, 3], [2, 2], [1, 1]]);
  assert.deepEqual(routeStops({ vertices: pts }), pts);
  assert.deepEqual(routeStops({ vertices: pts, waypoints: [pts[0], pts[2]] }), [pts[0], pts[2]]);
  const dense = Array.from({ length: 40 }, (_, i) => [i, i] as [number, number]);
  assert.deepEqual(routeStops({ vertices: dense }), [dense[0], dense[39]]);
  assert.deepEqual([0, 1, 2, 3].map((i) => stopLabel(i, 4)), ['A', '2', '3', 'B']);
  assert.equal(stopLabel(0, 1), 'A');
});

// --- Lighting ---

test('classifyLighting: classifies side, backlit, and front glare', async () => {
  const { classifyLighting } = await import('../src/map/routeGeometry.js');
  assert.equal(classifyLighting(0, 90), 'side');
  assert.equal(classifyLighting(0, 180), 'backlit');
  assert.equal(classifyLighting(0, 20), 'front');
});

test('routeLightingMix: percentages by distance; zero-length or stationary routes are empty', async () => {
  const { routeLightingMix } = await import('../src/map/routeGeometry.js');
  // Heading north with the sun in the east: pure side light.
  assert.deepEqual(routeLightingMix([[0, 0], [0, 1]], 'sprint', 90), { side: 100, backlit: 0, front: 0 });
  assert.deepEqual(routeLightingMix([[0, 0], [0, 0], [0, 1]], 'sprint', 90), { side: 100, backlit: 0, front: 0 });
  assert.deepEqual(routeLightingMix([[0, 0], [0, 0]], 'sprint', 90), { side: 0, backlit: 0, front: 0 });
  // A circuit out and back north/south: half front, half backlit for a due-north sun.
  assert.deepEqual(routeLightingMix([[0, 0], [0, 1]], 'circuit', 0), { side: 0, backlit: 50, front: 50 });
});

test('fetchOsrmFullRoute: rejects empty or malformed route geometry', async () => {
  const { fetchOsrmFullRoute } = await import('../src/map/routeGeometry.js');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: { coordinates: [] } }],
    }));
    assert.equal(await fetchOsrmFullRoute([[0, 0], [1, 1]]), null);

    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: { coordinates: [[0, 0], [1, null]] } }],
    }));
    assert.equal(await fetchOsrmFullRoute([[0, 0], [1, 1]]), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('routingWaypoints closes a loop through OSRM without duplicating an existing closing stop', () => {
  const points: [number, number][] = [[151, -33], [151.1, -33], [151.1, -33.1]];
  assert.deepEqual(routingWaypoints(points, 'sprint'), points);
  assert.deepEqual(routingWaypoints(points, 'circuit'), [...points, points[0]]);
  assert.deepEqual(routingWaypoints([...points, points[0]], 'circuit'), [...points, points[0]]);
});

test('fetchOsrmFullRoute uses all loop stops and rejects HTTP failures without replacement geometry', async () => {
  const originalFetch = globalThis.fetch;
  const points = routingWaypoints([[151, -33], [151.1, -33]], 'circuit');
  let requested = '';
  try {
    globalThis.fetch = async (url) => {
      requested = String(url);
      return new Response(JSON.stringify({
        code: 'Ok', routes: [{ distance: 1000, duration: 120, geometry: { coordinates: points } }],
      }));
    };
    assert.deepEqual(await fetchOsrmFullRoute(points), {
      coordinates: points, distanceMeters: 1000, durationSeconds: 120,
    });
    assert.match(requested, /151,-33;151\.1,-33;151,-33/);

    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    assert.equal(await fetchOsrmFullRoute(points), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
