import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';
import { clearRouteCache, MAX_ROUTE_POINTS, parseRouteCoords } from '../src/routing.js';

const app = await startApp({ OSRM_URL: 'http://osrm.test:5000/' });
after(() => app.close());
beforeEach(() => clearRouteCache());

const OK = { code: 'Ok', routes: [{ distance: 1200, duration: 90, geometry: { type: 'LineString', coordinates: [[151, -33], [151.01, -33.01]] }, legs: [{ steps: [] }] }] };

/** Answer OSRM's address from here; everything else (the app's own calls) goes through. */
function fakeOsrm(answer: (url: URL) => Response): { seen: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== 'osrm.test') return real(input, init);
    seen.push(url.pathname + url.search);
    return answer(url);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

async function member() {
  const c = app.client();
  await app.signIn(c, 'google', { id: 'g-driver', name: 'Driver' });
  return c;
}

test('route: a visitor who has not signed in is refused', async () => {
  const res = await app.client()('GET', '/api/route?coords=151,-33;151.1,-33.1');
  assert.equal(res.status, 401);
});

test('route: coordinates are checked before anything is asked upstream', async () => {
  const c = await member();
  const fake = fakeOsrm(() => new Response(JSON.stringify(OK)));
  try {
    const tooMany = Array.from({ length: MAX_ROUTE_POINTS + 1 }, (_, i) => `151.${i},-33`).join(';');
    for (const coords of ['', '151,-33', '151,-33;abc,def', '151,-33;200,-33', '151,-33;151,-91', '151,-33;1e3,5', '151,-33;151,-33,4', tooMany, '151,-33/../x;151,-34']) {
      const res = await c('GET', `/api/route?coords=${encodeURIComponent(coords)}`);
      assert.equal(res.status, 400, `"${coords.slice(0, 30)}" should be refused`);
      assert.ok(res.json.error);
    }
    assert.equal((await c('GET', '/api/route')).status, 400);
    assert.deepEqual(fake.seen, [], 'nothing reached OSRM');
  } finally { fake.restore(); }
});

test('route: a good request is proxied to OSRM_URL with the steps asked for, and cached', async () => {
  const c = await member();
  const fake = fakeOsrm(() => new Response(JSON.stringify(OK), { headers: { 'Content-Type': 'application/json' } }));
  try {
    const res = await c('GET', '/api/route?coords=151,-33;151.01,-33.01&steps=1');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, OK);
    assert.deepEqual(fake.seen, ['/route/v1/driving/151,-33;151.01,-33.01?geometries=geojson&overview=full&steps=true']);

    const again = await c('GET', '/api/route?coords=151,-33;151.01,-33.01&steps=1');
    assert.deepEqual(again.json, OK);
    assert.equal(fake.seen.length, 1, 'the second answer came from the cache');

    const plain = await c('GET', '/api/route?coords=151,-33;151.01,-33.01');
    assert.equal(plain.status, 200);
    assert.match(fake.seen[1], /steps=false$/, 'steps are part of the question');
  } finally { fake.restore(); }
});

test('route: "no route" is an answer, a broken upstream is a 502, and neither is cached as a success', async () => {
  const c = await member();
  let mode: 'noroute' | 'down' | 'html' = 'noroute';
  const fake = fakeOsrm(() => {
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'html') return new Response('<html>Bad Gateway</html>', { status: 502 });
    return new Response(JSON.stringify({ code: 'NoRoute', message: 'Impossible route between points' }), { status: 400 });
  });
  try {
    const none = await c('GET', '/api/route?coords=151,-33;0,0');
    assert.equal(none.status, 200);
    assert.equal(none.json.code, 'NoRoute');
    mode = 'down';
    assert.equal((await c('GET', '/api/route?coords=151,-33;0,0')).status, 502);
    mode = 'html';
    assert.equal((await c('GET', '/api/route?coords=151,-33;0,1')).status, 502);
    assert.equal(fake.seen.length, 3, 'a failure is asked again, not remembered');
  } finally { fake.restore(); }
});

test('route: the answer cache is capped', async () => {
  const c = await member();
  const fake = fakeOsrm(() => new Response(JSON.stringify(OK)));
  try {
    for (let i = 0; i < 205; i++) await c('GET', `/api/route?coords=151,-33;151,${-34 - i / 1000}`);
    await c('GET', `/api/route?coords=151,-33;151,-34`); // the oldest has been dropped
    assert.equal(fake.seen.length, 206);
  } finally { fake.restore(); }
});

test('parseRouteCoords: shapes and ranges', () => {
  assert.deepEqual(parseRouteCoords('151.2,-33.8;151.3,-33.9'), [[151.2, -33.8], [151.3, -33.9]]);
  assert.equal(typeof parseRouteCoords('151,-33'), 'string');
  assert.equal(typeof parseRouteCoords('181,0;0,0'), 'string');
  assert.equal(typeof parseRouteCoords('NaN,0;0,0'), 'string');
  assert.equal(typeof parseRouteCoords(undefined), 'string');
});

test('the page may load its manifest and service worker', async () => {
  const csp = (await app.client()('GET', '/api/version')).headers.get('content-security-policy') ?? '';
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
});
