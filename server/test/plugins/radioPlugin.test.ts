import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gatedApp, listen, makeRuntime, type Harness, type Listening } from './helpers.js';
import { radioPluginZip, RADIO_PLUGIN_ID } from './radioBundle.js';

/**
 * Radio Garden as the bundled plugin: the same routes, shapes and status codes
 * the app used to serve at /api/radio, with the upstream stubbed out.
 */

const ID = RADIO_PLUGIN_ID;
const BASE = `/api/plugins/${ID}`;
const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

interface Upstream {
  url: string;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PLACES = {
  data: {
    list: [
      { id: '9Yi25umJ', title: 'New York NY', country: 'United States', geo: [-74.005974, 40.712776], size: 183 },
      { id: 'bad-lat', title: 'Bad', country: 'Nowhere', geo: [10, 100] },
    ],
  },
};

const SYDNEY = {
  data: {
    title: 'Sydney',
    subtitle: 'Australia',
    content: [
      {
        itemsType: 'channel',
        items: [{ page: { type: 'channel', url: '/listen/fbi-radio/LWYfKJRw', title: 'FBi Radio', stream: 'fbiradio.com' } }],
      },
    ],
  },
};

/** The upstream, answered from fixtures. Each call is recorded so the tests can see what was asked. */
function upstreamFor(calls: Upstream[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === 'https://radio.garden/api/ara/content/places') return json(PLACES);
    if (url === 'https://radio.garden/api/ara/content/page/syd123') return json(SYDNEY);
    if (url === 'https://radio.garden/api/ara/content/page/nope') return new Response('Not found', { status: 404 });
    if (url === 'https://radio.garden/api/ara/content/page/down') return new Response('Oops', { status: 500 });
    if (url === 'https://radio.garden/api/ara/content/page/offline') throw new Error('getaddrinfo ENOTFOUND radio.garden');
    throw new Error(`unexpected upstream call: ${url}`);
  };
}

async function radio(stub?: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Upstream[] = [];
  const h = makeRuntime({ guardedFetch: stub ?? upstreamFor(calls) });
  harnesses.push(h);
  h.runtime.store.installFromZip(radioPluginZip(), { source: 'bundled' });
  await h.runtime.loadAll();
  const anon = await listen(gatedApp(h.runtime, null));
  servers.push(anon);
  const member = await listen(gatedApp(h.runtime, { id: 'member-1', role: 'contributor' }));
  servers.push(member);
  return { h, calls, anon: anon.base, member: member.base };
}

test('the plugin is active after install, and declares its three GET routes public', async () => {
  const { h } = await radio();
  assert.equal(h.runtime.status(ID)!.status, 'active');
  assert.equal(h.runtime.status(ID)!.name, 'Radio Garden');
  assert.deepEqual(h.runtime.status(ID)!.permissions, [{ kind: 'network', detail: 'radio.garden' }]);
  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/places'), true);
  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/places/abc/stations'), true);
  assert.equal(h.runtime.isPublicRoute(ID, 'HEAD', '/stations/abc/listen'), true);
  assert.equal(h.runtime.isPublicRoute(ID, 'POST', '/places'), false);
  assert.equal(h.runtime.isPublicRoute(ID, 'GET', '/anything-else'), false);
});

test('GET places answers { places } with the same fields as before, dropping malformed rows', async () => {
  const { anon } = await radio();
  const res = await fetch(`${anon}${BASE}/places`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    places: [{ id: '9Yi25umJ', title: 'New York NY', country: 'United States', lng: -74.005974, lat: 40.712776, stationCount: 183 }],
  });
});

test('GET places reaches radio.garden through the host fetch, with the provider headers kept', async () => {
  const { anon, calls } = await radio();
  await fetch(`${anon}${BASE}/places`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://radio.garden/api/ara/content/places');
  assert.equal(calls[0].headers.Referer, 'https://radio.garden/');
  assert.equal(calls[0].headers.Origin, 'https://radio.garden');
  assert.match(calls[0].headers['User-Agent'], /Mozilla/);
});

test('places are cached: a second visit does not ask radio.garden again', async () => {
  const { anon, calls } = await radio();
  await fetch(`${anon}${BASE}/places`);
  await fetch(`${anon}${BASE}/places`);
  assert.equal(calls.filter((c) => c.url.endsWith('/places')).length, 1);
});

test('GET places/:id/stations answers the place with its stations and plugin-relative listen links', async () => {
  const { anon } = await radio();
  const res = await fetch(`${anon}${BASE}/places/syd123/stations`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    placeId: 'syd123',
    title: 'Sydney',
    country: 'Australia',
    stations: [
      {
        id: 'LWYfKJRw',
        title: 'FBi Radio',
        placeId: 'syd123',
        streamDomain: 'fbiradio.com',
        listenUrl: `${BASE}/stations/LWYfKJRw/listen`,
      },
    ],
  });
});

test('a place id that is not a valid token is refused with 400 before anything is fetched', async () => {
  const { anon, calls } = await radio();
  const res = await fetch(`${anon}${BASE}/places/bad..id/stations`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid place ID' });
  assert.equal(calls.length, 0);
});

test('an unknown place is 404, a provider error 503, and a network failure 503, as before', async () => {
  const { anon } = await radio();
  const notFound = await fetch(`${anon}${BASE}/places/nope/stations`);
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).error, 'Radio Garden place not found');

  const down = await fetch(`${anon}${BASE}/places/down/stations`);
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error, 'Radio Garden returned HTTP 500');

  const offline = await fetch(`${anon}${BASE}/places/offline/stations`);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error, 'Radio Garden could not be reached', 'the network error text stays on the server');
});

test('GET stations/:id/listen redirects with 307 to the provider stream, and refuses bad ids', async () => {
  const { anon } = await radio();
  const ok = await fetch(`${anon}${BASE}/stations/LWYfKJRw/listen`, { redirect: 'manual' });
  assert.equal(ok.status, 307);
  assert.equal(ok.headers.get('location'), 'https://radio.garden/api/ara/content/listen/LWYfKJRw/channel.mp3');

  const bad = await fetch(`${anon}${BASE}/stations/invalid..id/listen`, { redirect: 'manual' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Invalid station channel ID' });
});

test('the three radio routes are open to a visitor; any other route of the plugin still needs a sign-in', async () => {
  const { anon, member } = await radio();
  assert.equal((await fetch(`${anon}${BASE}/stations/LWYfKJRw/listen`, { redirect: 'manual' })).status, 307);
  assert.equal((await fetch(`${anon}${BASE}/secret`)).status, 401, 'undeclared: sign in');
  assert.equal((await fetch(`${member}${BASE}/secret`)).status, 404, 'once signed in, it is simply not a route');
  assert.equal((await fetch(`${anon}${BASE}/places`, { method: 'POST' })).status, 401, 'writes need a sign-in');
});

test('an upstream answer larger than the page limit is refused with 502, however it arrives', async () => {
  let pulls = 0;
  const huge = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 20) controller.close();
      else controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const { anon } = await radio(async () => new Response(huge, { status: 200 }));
  const res = await fetch(`${anon}${BASE}/places/big/stations`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'Radio Garden response exceeded allowed size');
  assert.ok(pulls < 20, `the host read ${pulls} of 20 chunks`);
});
