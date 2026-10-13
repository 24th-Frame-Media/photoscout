import { Router } from 'express';

/**
 * Driving routes, asked of an OSRM server on the map's behalf.
 *
 * The browser used to call the public OSRM demo itself. That demo is for
 * trying things out, not for an app people navigate with, so the call comes
 * through here: one place to point at our own OSRM, to cap what is asked, and
 * to remember answers.
 */

// The public demo, for development only: it has no uptime promise and a strict
// usage policy. Production sets OSRM_URL to the osrm service (docker-compose.yml).
const DEMO_OSRM = 'https://router.project-osrm.org';
const osrmUrl = (): string => (process.env.OSRM_URL?.trim() || DEMO_OSRM).replace(/\/+$/, '');

/** A route with more stops than this is a map, not a drive. */
export const MAX_ROUTE_POINTS = 25;

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200;
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Stops from `lng,lat;lng,lat…`, or a reason they are refused. Every number
 * has to be a plain decimal in range: this text is pasted into a URL that goes
 * to another server.
 */
export function parseRouteCoords(raw: unknown): [number, number][] | string {
  if (typeof raw !== 'string' || !raw.trim()) return 'coords is required: lng,lat;lng,lat';
  const parts = raw.trim().split(';');
  if (parts.length < 2) return 'a route needs at least two points';
  if (parts.length > MAX_ROUTE_POINTS) return `a route takes at most ${MAX_ROUTE_POINTS} points`;
  const out: [number, number][] = [];
  for (const part of parts) {
    const pair = part.split(',');
    if (pair.length !== 2 || !pair.every((n) => /^-?\d+(\.\d+)?$/.test(n.trim()))) return `"${part.slice(0, 40)}" is not lng,lat`;
    const lng = Number(pair[0]), lat = Number(pair[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return `"${part.slice(0, 40)}" is outside valid lng/lat bounds`;
    out.push([lng, lat]);
  }
  return out;
}

// The last few minutes of answers, oldest dropped first. A drive re-asks for
// the same route whenever someone starts it again, and a reroute from the same
// spot is the same question.
// ponytail: per-process, like the rate limits; fine for one instance.
const cache = new Map<string, { at: number; body: string }>();

function remember(key: string, body: string): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), body });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** Test seam: the cache is module state, and a second test must not read the first one's answer. */
export function clearRouteCache(): void { cache.clear(); }

export const routing = Router();

routing.get('/api/route', async (req, res, next) => {
  try {
    const coords = parseRouteCoords(req.query.coords);
    if (typeof coords === 'string') return res.status(400).json({ error: coords });
    const steps = req.query.steps === '1' || req.query.steps === 'true';

    const path = coords.map(([lng, lat]) => `${lng},${lat}`).join(';');
    const key = `${osrmUrl()}|${path}|${steps}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return res.type('json').send(hit.body);

    const url = `${osrmUrl()}/route/v1/driving/${path}?geometries=geojson&overview=full&steps=${steps}`;
    let upstream: Response;
    try {
      upstream = await fetch(url, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch {
      return res.status(502).json({ error: 'The routing service did not answer' });
    }
    const text = await upstream.text();
    // OSRM says "no route" and "no segment near that point" as JSON with a code,
    // sometimes with a 4xx; those are answers, not failures.
    let code = '';
    try { code = String((JSON.parse(text) as { code?: unknown }).code ?? ''); } catch { /* not JSON */ }
    if (!code || (upstream.status >= 500)) return res.status(502).json({ error: 'The routing service gave no usable answer' });
    if (code === 'Ok') remember(key, text);
    res.type('json').send(text);
  } catch (err) { next(err); }
});
