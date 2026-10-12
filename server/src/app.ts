import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, photosDir } from './db.js';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import {
  SessionUser, Visibility,
  canEdit, canRead, needsAuth, originAllowed, readCookie, secureEqual, HANDLE, OAUTH_COOKIE, SESSION_COOKIE,
} from './auth.js';
import {
  accountIdOf, createSession, deleteSession, deleteUser, findUserById, listUsers,
  sessionUser, setUserBanned, setUserRole, setUsername, upsertOAuthUser, usernameTaken,
} from './authStore.js';
import { bodyProblem } from './bodyLimits.js';
import { configuredProviders, generateCodeVerifier, generateState, provider, publicUrl } from './oauth.js';
import { corsDecision, readOrigins } from './cors.js';
import { applySettingsUpdate, getSettings, memberSettings, publicSettings, tfnswKey } from './settings.js';
import { geocode } from './geocode.js';
import { bboxFromRadius, haversine, parseBbox, parseLatLng } from './geo.js';
import { parseGoodTimes, GoodTimesError, DEFAULT_GOOD_TIMES } from './goodTimes.js';
import { fetchPlanes, fetchPlaneInfo, isValidHex, isValidCallsign } from './feeds/planes.js';
import { fetchWeather } from './feeds/weather.js';
import { fetchMarine } from './feeds/marine.js';
import { fetchFires } from './feeds/rfs.js';
import { fetchAurora } from './feeds/spaceWeather.js';
import { fetchBuildings } from './sources/osm.js';
import { fetchRoadCell, parseCell } from './sources/roads.js';
import { fetchCameras } from './feeds/cameras.js';
import {
  buildPointPassesResponse, combinedFeedData, combinedRealtime, emptyFeedData, nextPasses, parsePointPassRequest, predictTrainPositions, tripCount, TRAIN_FEEDS,
} from './feeds/trains.js';
import { nearbyFor } from './feeds/eventScout.js';
import { getCachedRail, requestTilesForUnsnapped, trackGraphFor } from './sources/rail.js';
import { commonsNearbyCached, lensStats } from './sources/commons.js';
import { coverFields, deleteImages, detectImageType, MAX_PHOTO_BYTES, parseMultipart, saveImage, SPOT_COVER_COLS } from './photos.js';
import { buildGpx } from './gpx.js';
import { buildFeatureCollection, importFeatureCollection, ShareBundle, syncRemote } from './share.js';
import { assertPublicUrl, guardedFetch } from './ssrf.js';
import { tasks } from './tasks/tasks.js';
import { versionInfo } from './version.js';
import { isRouteType, parseRouteSnap, parseRouteStaging, parseRouteVertices, serializeRouteWaypoints, routeJson, type RouteRow } from './routes.js';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      user: SessionUser | null;
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

function trustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// --- headers ----------------------------------------------------------------

// The map draws tiles, terrain and radar from a dozen hosts and runs its
// shadow maths in blob workers, so images, fetches and workers are open to
// https; scripts are not, which is the part that matters.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'connect-src': ["'self'", 'https:'],
        'worker-src': ["'self'", 'blob:'],
        'font-src': ["'self'", 'data:', 'https:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // Photos and exports are fetched by other PhotoScouts through a share link.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

app.use(express.json({ limit: '2mb' }));

// --- CORS, the session, the origin check, the limits, then the gate ----------

app.use('/api', (req, res, next) => {
  const decision = corsDecision(
    {
      origin: req.headers.origin,
      method: req.method,
      path: req.baseUrl + req.path,
      requestMethod: req.headers['access-control-request-method'] as string | undefined,
    },
    readOrigins(getSettings(db).corsOrigins)
  );
  if (decision) {
    res.vary(decision.vary);
    res.set(decision.headers);
    if (decision.preflight) return res.sendStatus(204);
  }
  next();
});

app.use('/api', (req, _res, next) => {
  req.user = sessionUser(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  next();
});

app.use('/api', (req, res, next) => {
  if (originAllowed(req.method, req.headers.origin, publicUrl())) return next();
  res.status(403).json({ error: 'Cross-site request refused' });
});

/**
 * Limits by who is asking: the account when there is one, otherwise the
 * address. Counted in memory, which is right for one process and wrong for
 * several.
 * ponytail: per-process counters; move to a shared store if this ever runs as more than one instance.
 */
const limitKey = (req: express.Request): string => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? ''));
const limit = (windowMs: number, max: number, what: string) =>
  rateLimit({
    windowMs,
    limit: max,
    keyGenerator: limitKey,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.RATE_LIMITS === 'off',
    message: { error: `Too many ${what} — slow down and try again shortly` },
  });

const MINUTE = 60_000;
// Everything, as a ceiling. A map screen makes a burst of requests when it
// opens, so this is generous; the tighter ones below are what bite.
app.use('/api', limit(MINUTE, 600, 'requests'));
// Sign-in round trips, by address: nobody has an account yet at this point.
app.use('/api/auth', limit(10 * MINUTE, 40, 'sign-in attempts'));
// Anything that changes something.
app.use('/api', (req, res, next) =>
  req.method === 'GET' || req.method === 'HEAD' ? next() : writeLimit(req, res, next)
);
const writeLimit = limit(MINUTE, 90, 'changes');
// Routes that make this server ask somebody else's: each request here costs a
// third party one, so they are counted on their own and kept low.
const upstreamLimit = limit(MINUTE, 60, 'lookups');
app.use(
  ['/api/geocode', '/api/planes', '/api/weather', '/api/marine', '/api/buildings', '/api/roads', '/api/cameras', '/api/candidates'],
  upstreamLimit
);
app.use(/^\/api\/(spots|places)\/[^/]+\/(nearby|commons|trains)$/, upstreamLimit);
/** Photo uploads: each is held in memory while it is checked, so few at a time. */
const uploadLimit = limit(10 * MINUTE, 60, 'uploads');

app.use('/api', (req, res, next) => {
  if (!needsAuth(req.method, req.baseUrl + req.path)) return next();
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in required' });
});

/**
 * Sizes and ranges for what people type into a place, a spot or a route.
 * The handlers below check what each field means; this only refuses the
 * shapes none of them should ever be handed, in one place.
 */
app.use(['/api/places', '/api/spots', '/api/routes'], (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return next();
  const problem = bodyProblem((req.body ?? {}) as Record<string, unknown>);
  if (problem) return res.status(400).json({ error: problem });
  next();
});

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'Admins only' });
  return false;
}

// --- auth -------------------------------------------------------------------

const secureCookie = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

app.get('/api/auth/status', (req, res) => {
  res.json({
    authed: Boolean(req.user),
    user: req.user ? findUserById(db, req.user.id) : null,
    // What to put in ADMIN_IDS to make this account an admin. Its own, and only to itself.
    account: req.user ? accountIdOf(db, req.user.id) : null,
    providers: configuredProviders(),
  });
});

/** Send the browser to the provider, remembering what was sent so the answer can be checked. */
app.get('/api/auth/:provider/start', (req, res) => {
  const p = provider(req.params.provider);
  if (!p) return res.status(404).json({ error: 'That sign-in is not set up' });
  const state = generateState();
  const verifier = generateCodeVerifier();
  res.cookie(OAUTH_COOKIE, `${req.params.provider}.${state}.${verifier}`, { ...secureCookie, maxAge: 10 * MINUTE });
  res.redirect(p.authorizationUrl(state, verifier).toString());
});

/**
 * The provider's answer. The state in the query has to be the one in the
 * cookie this browser was given at the start, which is what stops somebody
 * else's sign-in being finished in this browser.
 */
app.get('/api/auth/:provider/callback', async (req, res) => {
  const fail = (why: string) => res.redirect(`/login?error=${encodeURIComponent(why)}`);
  const [name, state, verifier] = (readCookie(req.headers.cookie, OAUTH_COOKIE) ?? '').split('.');
  res.clearCookie(OAUTH_COOKIE, secureCookie);
  const p = provider(req.params.provider);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const returned = typeof req.query.state === 'string' ? req.query.state : '';
  if (!p || !code || !state || !verifier || name !== req.params.provider || !secureEqual(returned, state)) {
    return fail('Sign-in could not be completed. Please try again.');
  }
  try {
    const profile = await p.profile(code, verifier);
    const user = upsertOAuthUser(db, { provider: req.params.provider, ...profile });
    if (user.banned) return fail('This account has been suspended.');
    const { token, maxAgeMs } = createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, { ...secureCookie, maxAge: maxAgeMs });
    res.redirect('/');
  } catch (err) {
    console.error(`[auth] ${req.params.provider} sign-in failed:`, (err as Error).message);
    fail('Sign-in could not be completed. Please try again.');
  }
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  res.clearCookie(SESSION_COOKIE, secureCookie);
  res.json({ ok: true });
});

/** Change your own handle. */
app.patch('/api/auth/me', (req, res) => {
  const username = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof username !== 'string' || !HANDLE.test(username)) {
    return res.status(400).json({ error: 'A handle is 3 to 24 letters, digits or underscores' });
  }
  const me = findUserById(db, req.user!.id);
  if (me && me.username.toLowerCase() !== username.toLowerCase() && usernameTaken(db, username)) {
    return res.status(409).json({ error: 'That handle is taken' });
  }
  setUsername(db, req.user!.id, username);
  res.json(findUserById(db, req.user!.id));
});

// --- users (admin) -----------------------------------------------------------

app.get('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(listUsers(db));
});
app.patch('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!findUserById(db, req.params.id)) return res.status(404).json({ error: 'No such user' });
  const { role, banned } = (req.body ?? {}) as { role?: unknown; banned?: unknown };
  const self = req.params.id === req.user!.id;
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'contributor') return res.status(400).json({ error: 'role must be admin or contributor' });
    if (self) return res.status(400).json({ error: 'Cannot change your own role' });
    setUserRole(db, req.params.id, role);
  }
  if (banned !== undefined) {
    if (typeof banned !== 'boolean') return res.status(400).json({ error: 'banned must be true or false' });
    if (self) return res.status(400).json({ error: 'Cannot suspend your own account' });
    setUserBanned(db, req.params.id, banned);
  }
  res.json(findUserById(db, req.params.id));
});
app.delete('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  deleteUser(db, req.params.id);
  res.json({ ok: true });
});

// --- settings -----------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  const settings = getSettings(db);
  res.json(req.user?.role === 'admin' ? publicSettings(settings) : memberSettings(settings));
});
app.put('/api/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { settings, keyChanged } = applySettingsUpdate(db, (req.body ?? {}) as Record<string, unknown>);
  // A new key means timetables can now be pulled: start the import in the background.
  if (keyChanged && settings.tfnswApiKey) {
    for (const name of ['trains-static-nswtrains', 'trains-static-sydneytrains']) {
      tasks.run(name, { force: true }).catch(() => {});
    }
  }
  res.json(publicSettings(settings));
});

// --- geocode / version ----------------------------------------------------------

app.get('/api/geocode', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json([]);
    res.json(await geocode(db, q));
  } catch (err) { next(err); }
});

app.get('/api/version', (_req, res) => res.json(versionInfo()));

// --- places / spots: shared visibility helpers ---------------------------------

/** SQL fragment (with its params) restricting rows to what `user` may list. Unlisted rows never appear in a list. */
function listVisibilityWhere(user: SessionUser | null | undefined): { sql: string; params: string[] } {
  if (user) return { sql: "(visibility = 'public' OR (visibility = 'private' AND owner_id = ?))", params: [user.id] };
  return { sql: "visibility = 'public'", params: [] };
}

interface PlaceRow {
  id: string; owner_id: string; name: string; notes: string; access: string; lat: number; lng: number;
  geom: string | null; visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
}
function placeJson(r: PlaceRow) {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, notes: r.notes, access: r.access, lat: r.lat, lng: r.lng,
    geom: r.geom ? JSON.parse(r.geom) : null, visibility: r.visibility, source: r.source, sourceRef: r.source_ref,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface SpotRow {
  id: string; place_id: string | null; owner_id: string; name: string; notes: string; lat: number; lng: number;
  tags: string; facing_deg: number | null; fov_deg: number | null; good_times: string;
  visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
  photo_count?: number; cover_id?: string | null;
}
function spotJson(r: SpotRow) {
  return {
    id: r.id, placeId: r.place_id, ownerId: r.owner_id, name: r.name, notes: r.notes, lat: r.lat, lng: r.lng,
    tags: JSON.parse(r.tags), facingDeg: r.facing_deg, fovDeg: r.fov_deg, goodTimes: JSON.parse(r.good_times),
    visibility: r.visibility, source: r.source, sourceRef: r.source_ref, createdAt: r.created_at, updatedAt: r.updated_at,
    ...coverFields(r),
  };
}

function isVisibility(v: unknown): v is Visibility {
  return v === 'private' || v === 'unlisted' || v === 'public';
}

// --- places --------------------------------------------------------------------

app.get('/api/places', (req, res) => {
  const { sql, params } = listVisibilityWhere(req.user);
  const rows = db.handle.prepare(`SELECT * FROM places WHERE ${sql} ORDER BY name`).all(...params) as unknown as PlaceRow[];
  res.json(rows.map(placeJson));
});

app.post('/api/places', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO places (id, owner_id, name, notes, access, lat, lng, geom, visibility, source, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, b.name.trim(), String(b.notes ?? ''), String(b.access ?? ''), b.lat, b.lng,
      b.geom ? JSON.stringify(b.geom) : null, visibility, 'manual', '', now, now);
  res.status(201).json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(id) as unknown as PlaceRow));
});

app.get('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(placeJson(row));
});

app.patch('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const next = {
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    access: typeof b.access === 'string' ? b.access : row.access,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    geom: b.geom !== undefined ? (b.geom ? JSON.stringify(b.geom) : null) : row.geom,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE places SET name=?, notes=?, access=?, lat=?, lng=?, geom=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.name, next.notes, next.access, next.lat, next.lng, next.geom, next.visibility, new Date().toISOString(), row.id);
  res.json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(row.id) as unknown as PlaceRow));
});

app.delete('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  // Spots outlive their place: detached, not deleted.
  db.handle.prepare('UPDATE spots SET place_id = NULL WHERE place_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM places WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- spots ----------------------------------------------------------------------

app.get('/api/spots', (req, res) => {
  try {
    const { sql, params } = listVisibilityWhere(req.user);
    const clauses = [sql];
    const args: any[] = [...params]; // mixed string/number bind params for the prepared statement below

    if (typeof req.query.placeId === 'string') {
      clauses.push('place_id = ?');
      args.push(req.query.placeId);
    }

    let bbox = null as ReturnType<typeof parseBbox> | null;
    if (typeof req.query.bbox === 'string') bbox = parseBbox(req.query.bbox);
    else if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusKm = Number(req.query.radiusKm ?? 10);
      bbox = bboxFromRadius(lat, lng, radiusKm);
    }
    if (bbox) {
      clauses.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
      args.push(bbox.south, bbox.north, bbox.west, bbox.east);
    }

    let rows = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE ${clauses.join(' AND ')} ORDER BY name`).all(...args) as unknown as SpotRow[];

    // near= is a circle; the bbox above is only its bounding box.
    if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusM = Number(req.query.radiusKm ?? 10) * 1000;
      rows = rows.filter((r) => haversine(lat, lng, r.lat, r.lng) <= radiusM);
    }

    res.json(rows.map(spotJson));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/spots', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  let goodTimes;
  try {
    goodTimes = parseGoodTimes(b.goodTimes);
  } catch (err) {
    if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', '', ?, ?)`
    )
    .run(id, b.placeId ? String(b.placeId) : null, req.user!.id, b.name.trim(), String(b.notes ?? ''), b.lat, b.lng,
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []), typeof b.facingDeg === 'number' ? b.facingDeg : null,
      typeof b.fovDeg === 'number' ? b.fovDeg : null, JSON.stringify(goodTimes), visibility, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

app.get('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(req.params.id) as unknown as SpotRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(spotJson(row));
});

app.patch('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  let goodTimes = JSON.parse(row.good_times);
  if (b.goodTimes !== undefined) {
    try {
      goodTimes = parseGoodTimes(b.goodTimes);
    } catch (err) {
      if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }
  const next = {
    place_id: b.placeId !== undefined ? (b.placeId ? String(b.placeId) : null) : row.place_id,
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    tags: b.tags !== undefined ? JSON.stringify(Array.isArray(b.tags) ? b.tags : []) : row.tags,
    facing_deg: b.facingDeg !== undefined ? (typeof b.facingDeg === 'number' ? b.facingDeg : null) : row.facing_deg,
    fov_deg: b.fovDeg !== undefined ? (typeof b.fovDeg === 'number' ? b.fovDeg : null) : row.fov_deg,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE spots SET place_id=?, name=?, notes=?, lat=?, lng=?, tags=?, facing_deg=?, fov_deg=?, good_times=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.place_id, next.name, next.notes, next.lat, next.lng, next.tags, next.facing_deg, next.fov_deg,
      JSON.stringify(goodTimes), next.visibility, new Date().toISOString(), row.id);
  res.json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(row.id) as unknown as SpotRow));
});

app.delete('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const photos = db.handle.prepare('SELECT file, thumb FROM photos WHERE spot_id = ?').all(row.id) as { file: string; thumb: string }[];
  deleteImages(photos.flatMap((p) => [p.file, p.thumb]));
  db.handle.prepare('DELETE FROM photos WHERE spot_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM spots WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- photos -----------------------------------------------------------------

interface PhotoRow {
  id: string; spot_id: string; owner_id: string; kind: string; file: string; thumb: string;
  w: number; h: number; taken_at: string | null; caption: string; created_at: string;
  focal_length?: number | null; date_time_original?: string | null;
}
function photoJson(r: PhotoRow) {
  return {
    id: r.id, spotId: r.spot_id, kind: r.kind, url: `/api/photos/${r.id}/file`, thumbUrl: `/api/photos/${r.id}/thumb`,
    w: r.w, h: r.h, takenAt: r.taken_at, caption: r.caption, createdAt: r.created_at,
    focalLength: r.focal_length ?? null,
    dateTimeOriginal: r.date_time_original ?? r.taken_at ?? null,
  };
}

/** Photos one account may add in a day. Disk is the thing a public upload form runs out of. */
const MAX_PHOTOS_PER_DAY = 200;

app.post('/api/spots/:id/photos', uploadLimit, async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot) return res.status(404).json({ error: 'Not found' });
    if (!canEdit(spot.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
    const today = db.handle.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner_id = ? AND created_at > ?')
      .get(req.user!.id, new Date(Date.now() - 86_400_000).toISOString()) as { n: number };
    if (today.n >= MAX_PHOTOS_PER_DAY) return res.status(429).json({ error: 'Daily photo limit reached. Try again tomorrow.' });

    const { fields, files } = await parseMultipart(req, MAX_PHOTO_BYTES * 2 + 4096);
    if (!files.photo || !detectImageType(files.photo)) return res.status(400).json({ error: 'photo must be a JPEG, PNG or WebP file' });
    const thumbBuf = files.thumb && detectImageType(files.thumb) ? files.thumb : files.photo;

    const parsedFocal = fields.focalLength ? Number(fields.focalLength) : null;
    const focalLength = parsedFocal !== null && Number.isFinite(parsedFocal) && parsedFocal > 0 ? parsedFocal : null;
    const takenAt = fields.takenAt || null;
    const dateTimeOriginal = takenAt;

    const file = saveImage(files.photo);
    const thumb = saveImage(thumbBuf);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const kind = fields.kind === 'of_location' ? 'of_location' : 'taken_here';
    db.handle
      .prepare('INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, w, h, taken_at, caption, created_at, focal_length, date_time_original) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, spot.id, req.user!.id, kind, file, thumb, Number(fields.w ?? 0) || 0, Number(fields.h ?? 0) || 0,
        takenAt, String(fields.caption ?? '').slice(0, 2000), now, focalLength, dateTimeOriginal);
    res.status(201).json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(id) as unknown as PhotoRow));
  } catch (err) { next(err); }
});

function servePhoto(variant: 'file' | 'thumb') {
  return (req: express.Request, res: express.Response) => {
    const row = db.handle.prepare('SELECT p.*, s.visibility as spot_visibility, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
      .get(req.params.id) as (PhotoRow & { spot_visibility: Visibility; spot_owner_id: string }) | undefined;
    if (!row || !canRead(row.spot_visibility, row.spot_owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
  };
}
app.get('/api/photos/:id/file', servePhoto('file'));
app.get('/api/photos/:id/thumb', servePhoto('thumb'));

app.get('/api/spots/:id/photos', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  const rows = db.handle.prepare('SELECT * FROM photos WHERE spot_id = ? ORDER BY created_at').all(spot.id) as unknown as PhotoRow[];
  res.json(rows.map(photoJson));
});

app.patch('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const caption = typeof b.caption === 'string' ? b.caption.slice(0, 500) : row.caption;
  const kind = b.kind === 'of_location' || b.kind === 'taken_here' ? b.kind : row.kind;
  db.handle.prepare('UPDATE photos SET caption = ?, kind = ? WHERE id = ?').run(caption, kind, row.id);
  res.json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(row.id) as unknown as PhotoRow));
});

app.delete('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  deleteImages([row.file, row.thumb]);
  db.handle.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- import / export ----------------------------------------------------------

app.post('/api/import', (req, res) => {
  const bundle = req.body as ShareBundle;
  if (!bundle || bundle.type !== 'FeatureCollection' || !Array.isArray(bundle.features)) {
    return res.status(400).json({ error: 'A GeoJSON FeatureCollection is required' });
  }
  res.json(importFeatureCollection(db, bundle, req.user!.id));
});

app.get('/api/export.geojson', (req, res) => {
  const bundle = buildFeatureCollection(db, req.user!.id, (id, variant) => `/api/photos/${id}/${variant}`);
  res.json(bundle);
});

app.get('/api/export.gpx', (req, res) => {
  const rows = db.handle.prepare('SELECT name, notes, lat, lng FROM spots WHERE owner_id = ?').all(req.user!.id) as
    { name: string; notes: string; lat: number; lng: number }[];
  res.type('application/gpx+xml').send(buildGpx(rows.map((r) => ({ lat: r.lat, lng: r.lng, name: r.name, desc: r.notes }))));
});

// --- shares -------------------------------------------------------------------

interface ShareRow { token: string; owner_id: string; filter: string; created_at: string; revoked_at: string | null }

app.get('/api/shares', (req, res) => {
  const rows = req.user!.role === 'admin'
    ? db.handle.prepare('SELECT * FROM shares').all()
    : db.handle.prepare('SELECT * FROM shares WHERE owner_id = ?').all(req.user!.id);
  res.json(rows);
});

/** Live share links one account may hold. A link hands over everything its owner has, private rows included. */
const MAX_SHARES = 20;

app.post('/api/shares', (req, res) => {
  const live = db.handle.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id = ? AND revoked_at IS NULL').get(req.user!.id) as { n: number };
  if (live.n >= MAX_SHARES) return res.status(400).json({ error: `You can have ${MAX_SHARES} share links at once: revoke one first` });
  const token = crypto.randomBytes(18).toString('base64url');
  db.handle
    .prepare('INSERT INTO shares (token, owner_id, filter, created_at) VALUES (?, ?, ?, ?)')
    .run(token, req.user!.id, '{}', new Date().toISOString());
  res.status(201).json({ token });
});

app.delete('/api/shares/:token', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token) as unknown as ShareRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('UPDATE shares SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), req.params.token);
  res.json({ ok: true });
});

function activeShare(token: string): ShareRow | null {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(token) as unknown as ShareRow | undefined;
  return row && !row.revoked_at ? row : null;
}

/** The bundle a share token grants — no session needed, the token is the credential. */
app.get('/api/share/:token', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  res.json(buildFeatureCollection(db, share.owner_id, (id, variant) => `/api/share/${req.params.token}/photos/${id}/${variant}`));
});

app.get('/api/share/:token/photos/:id/:variant', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  const variant = req.params.variant === 'thumb' ? 'thumb' : 'file';
  const row = db.handle.prepare('SELECT p.* FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ? AND s.owner_id = ?')
    .get(req.params.id, share.owner_id) as unknown as PhotoRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
});

// --- remotes --------------------------------------------------------------------

interface RemoteRow { id: string; owner_id: string; url: string; last_sync: string | null; last_error: string | null; created_at: string }

// Admins only, all of it: a remote is a URL this server goes and fetches on a
// timer, and on a public instance that is not something to hand every account.
app.use('/api/remotes', (req, res, next) => { if (requireAdmin(req, res)) next(); });

app.get('/api/remotes', (_req, res) => {
  res.json(db.handle.prepare('SELECT * FROM remotes').all());
});

app.post('/api/remotes', async (req, res) => {
  const { url } = (req.body ?? {}) as { url?: unknown };
  if (typeof url !== 'string' || !url || url.length > 2000) return res.status(400).json({ error: 'url is required' });
  try {
    await assertPublicUrl(url, getSettings(db).allowPrivateRemotes);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const id = crypto.randomUUID();
  db.handle.prepare('INSERT INTO remotes (id, owner_id, url, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, url, new Date().toISOString());
  res.status(201).json(db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(id));
});

app.delete('/api/remotes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM remotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/remotes/:id/sync', async (req, res, next) => {
  try {
    const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const result = await syncRemote(db, row, getSettings(db).allowPrivateRemotes);
    db.handle.prepare('UPDATE remotes SET last_sync = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
    res.json(result);
  } catch (err) {
    db.handle.prepare('UPDATE remotes SET last_error = ? WHERE id = ?').run((err as Error).message, req.params.id);
    next(err);
  }
});

// --- tasks (read-only status; the scheduler drives the actual runs) -------------

app.get('/api/tasks', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const since = Number(req.query.since ?? 0);
  res.json({ tasks: tasks.statuses(), ...tasks.since(since) });
});
app.post('/api/tasks/:name/run', (req, res, next) => {
  if (!requireAdmin(req, res)) return;
  tasks.run(req.params.name, { force: true }).then((result) => res.json(result)).catch(next);
});

// --- planes -------------------------------------------------------------------

app.get('/api/planes', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const nm = Number(req.query.nm ?? 40);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.ADSB_URL ?? 'https://api.adsb.lol';
    res.json(await fetchPlanes(baseUrl, lat, lng, nm));
  } catch (err) { next(err); }
});

app.get('/api/planes/:hex/info', async (req, res, next) => {
  try {
    const { hex } = req.params;
    if (!isValidHex(hex)) return res.status(400).json({ error: 'Invalid hex: must be 6 hex characters' });
    let callsign: string | undefined = undefined;
    if (req.query.callsign !== undefined && req.query.callsign !== '') {
      const cs = String(req.query.callsign).trim();
      if (!isValidCallsign(cs)) return res.status(400).json({ error: 'Invalid callsign: must be alphanumeric and up to 8 characters' });
      callsign = cs;
    }
    res.json(await fetchPlaneInfo(hex, callsign));
  } catch (err) { next(err); }
});

// --- weather ------------------------------------------------------------------

app.get('/api/weather', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.OPEN_METEO_URL ?? 'https://api.open-meteo.com';
    res.json(await fetchWeather(baseUrl, lat, lng, Number.isFinite(days) ? days : 7));
  } catch (err) { next(err); }
});

// --- marine (tides & swell) ---------------------------------------------------

app.get('/api/marine', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    const baseUrl = process.env.OPEN_METEO_MARINE_URL ?? 'https://marine-api.open-meteo.com';
    res.json(await fetchMarine(baseUrl, lat, lng));
  } catch (err) { next(err); }
});

// --- fires (NSW RFS) ----------------------------------------------------

app.get('/api/fires', async (_req, res, next) => {
  try {
    res.json(await fetchFires());
  } catch (err) { next(err); }
});

// --- aurora (NOAA space weather) ----------------------------------------

app.get('/api/aurora', async (_req, res, next) => {
  try {
    res.json(await fetchAurora());
  } catch (err) { next(err); }
});

// Building footprints around a point, for Plan shoot's building shadows (the page has no map to read vector tiles from).
app.get('/api/buildings', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const r = Number(req.query.r ?? 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat and lng are out of range' });
    // Fifty-metre steps between 50 and 500: every distinct radius is its own
    // cache row and its own Overpass query.
    const radius = Math.min(500, Math.max(50, Math.round((Number.isFinite(r) ? r : 250) / 50) * 50));
    // Footprints barely change: cache per ~10 m cell for a week so Overpass outages don't blank building shade.
    const key = `buildings:${lat.toFixed(4)},${lng.toFixed(4)}:${Math.round(radius)}`;
    const cached = db.getKv(key);
    if (cached) return res.type('application/json').send(cached);
    try {
      const fc = await fetchBuildings(lat, lng, radius);
      db.setKv(key, JSON.stringify(fc), new Date(Date.now() + 7 * 86_400_000).toISOString());
      res.json(fc);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  } catch (err) { next(err); }
});

// --- rail network --------------------------------------------

app.get('/api/rail', (_req, res) => res.json(getCachedRail(db)));

// --- trains -----------------------------------------------------------------

app.get('/api/trains/status', (_req, res) => {
  const configured = Boolean(tfnswKey(db));
  const lastImport = TRAIN_FEEDS.map((f) => db.getKv(`trains:lastImport:${f}`)).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
  res.json({ configured, lastImport, tripCount: tripCount(db) });
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.json({ configured: false, positions: [] });
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    // Realtime describes *now*; only mix it in when asked about (roughly) now.
    const nearNow = Math.abs(at.getTime() - Date.now()) < 5 * 60_000;
    const [feed, realtime] = [combinedFeedData(db), nearNow ? await combinedRealtime(key) : []];
    const unsnapped = predictTrainPositions(feed, at, realtime);
    const track = trackGraphFor(db, unsnapped);
    const positions = predictTrainPositions(feed, at, realtime, track);
    requestTilesForUnsnapped(db, positions);
    res.json({ configured: true, positions });
  } catch (err) { next(err); }
});

app.get('/api/trains/passes', (req, res) => {
  const parsed = parsePointPassRequest(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const key = tfnswKey(db);
  res.json(buildPointPassesResponse(Boolean(key), key ? combinedFeedData(db) : emptyFeedData(), parsed.point, parsed.hours, new Date()));
});

app.get('/api/spots/:id/trains', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  if (!tfnswKey(db)) return res.json({ configured: false, passes: [] });
  const hours = Number(req.query.hours ?? 6);
  const passes = nextPasses(combinedFeedData(db), spot, hours, new Date());
  res.json({ configured: true, passes });
});

// --- traffic cameras (TfNSW) --------------------------------------------------

app.get('/api/cameras', async (_req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.json({ configured: false, cameras: [] });
    const cameras = await fetchCameras(key);
    res.json({ configured: true, cameras });
  } catch (err) {
    const status = (err as any).status ?? 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.get('/api/cameras/:id/image', async (req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.status(404).json({ error: 'Not configured' });
    const cameras = await fetchCameras(key);
    const camera = cameras.find((c) => c.id === req.params.id);
    if (!camera || !camera.imageUrl) return res.status(404).json({ error: 'Camera not found' });
    const url = new URL(camera.imageUrl);
    if (url.protocol !== 'https:') return res.status(502).json({ error: 'Camera image is not https' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // The key only goes to TfNSW's own API host, never to wherever the feed points images.
      const headers: Record<string, string> = { 'User-Agent': 'photoscout/0.1' };
      if (url.hostname === 'api.transport.nsw.gov.au') headers.Authorization = `apikey ${key}`;
      const imgRes = await fetch(url, { headers, signal: controller.signal });
      if (!imgRes.ok) return res.status(502).json({ error: `Image fetch failed (${imgRes.status})` });
      const contentType = imgRes.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) return res.status(502).json({ error: 'Camera image is not an image' });
      res.setHeader('Content-Type', contentType);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.send(buf);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) { next(err); }
});

// --- Event Scout: nearby events and busyness --------------------------------------

function nearbyOriginForSpot(row: SpotRow): { lat: number; lng: number } {
  if (row.place_id) {
    const place = db.handle.prepare('SELECT lat, lng FROM places WHERE id = ?').get(row.place_id) as { lat: number; lng: number } | undefined;
    if (place) return place;
  }
  return { lat: row.lat, lng: row.lng };
}

app.get('/api/spots/:id/nearby', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    const origin = nearbyOriginForSpot(spot);
    const goodTimes = JSON.parse(spot.good_times) as { eventKeywords?: string[] };
    res.json(await nearbyFor(db, getSettings(db).eventScoutUrl, origin.lat, origin.lng, goodTimes.eventKeywords ?? []));
  } catch (err) { next(err); }
});

app.get('/api/places/:id/nearby', async (req, res, next) => {
  try {
    const place = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
    if (!place || !canRead(place.visibility, place.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.json(await nearbyFor(db, getSettings(db).eventScoutUrl, place.lat, place.lng, []));
  } catch (err) { next(err); }
});

// --- candidates (OSM) + Commons inspiration ---------------------------------------

app.get('/api/candidates', (req, res) => {
  try {
    let rows: any[];
    if (typeof req.query.bbox === 'string') {
      const b = parseBbox(req.query.bbox);
      rows = db.handle.prepare('SELECT * FROM candidates WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').all(b.south, b.north, b.west, b.east);
    } else {
      rows = db.handle.prepare('SELECT * FROM candidates').all();
    }
    res.json(rows.map((r) => ({ id: r.id, source: r.source, ref: r.ref, name: r.name, lat: r.lat, lng: r.lng, tags: JSON.parse(r.tags), fetchedAt: r.fetched_at })));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Road quality (OSM): one 0.05 degree grid cell per request (?cell=south,west), cached 14 days.
// Concurrent requests for the same cell share one Overpass fetch.
const roadsInflight = new Map<string, Promise<string>>();
app.get('/api/roads', async (req, res) => {
  const c = parseCell(String(req.query.cell ?? ''));
  if (!c) return res.status(400).json({ error: 'cell must be south,west on the 0.05 degree grid' });
  const key = `roads:${c.south},${c.west}`;
  try {
    let json = db.getKv(key);
    if (!json) {
      let p = roadsInflight.get(key);
      if (!p) {
        p = fetchRoadCell(c).then((cell) => {
          const out = JSON.stringify(cell);
          db.setKv(key, out, new Date(Date.now() + 14 * 86_400_000).toISOString());
          return out;
        }).finally(() => roadsInflight.delete(key));
        roadsInflight.set(key, p);
      }
      json = await p;
    }
    res.type('json').send(`{"type":"FeatureCollection","features":${json}}`);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.post('/api/candidates/:id/promote', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '', ?, ?, '[]', NULL, NULL, ?, 'private', 'osm', ?, ?, ?)`
    )
    .run(id, req.user!.id, row.name || 'Candidate', row.lat, row.lng, JSON.stringify(DEFAULT_GOOD_TIMES), row.ref, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

app.get('/api/eventscout/test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const url = String(req.query.url ?? getSettings(db).eventScoutUrl ?? '');
  if (!url) return res.json({ ok: false, message: 'No URL set' });
  try {
    const buf = await guardedFetch(`${url.replace(/\/$/, '')}/api/density/areas`, true);
    const data = JSON.parse(buf.toString('utf8')) as { areas?: unknown[] };
    res.json({ ok: true, message: `Reached it — ${data.areas?.length ?? 0} density area(s)` });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message });
  }
});

app.get('/api/spots/:id/commons', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    const images = await commonsNearbyCached(db, spot.lat, spot.lng);
    const ownRows = db.handle
      .prepare('SELECT focal_length, taken_at, date_time_original FROM photos WHERE spot_id = ?')
      .all(spot.id) as { focal_length: number | null; taken_at: string | null; date_time_original: string | null }[];
    const allPhotos = [
      // Commons clocks are often left on the uploader's home zone, so only own photos inform the time of day.
      ...images.map((c) => ({ focal35: c.focal35, focalRaw: c.focalRaw, takenAt: null })),
      ...ownRows.map((p) => ({
        focal35: null,
        focalRaw: p.focal_length,
        takenAt: p.date_time_original ?? p.taken_at,
      })),
    ];
    const stats = lensStats(allPhotos);
    res.json({ images, stats });
  } catch (err) { next(err); }
});

// --- routes -----------------------------------------------------------------

app.get('/api/routes', (req, res) => {
  const { sql, params } = listVisibilityWhere(req.user);
  const rows = db.handle.prepare(`SELECT * FROM routes WHERE ${sql} ORDER BY name`).all(...params) as unknown as RouteRow[];
  res.json(rows.map(routeJson));
});

app.post('/api/routes', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  let vertices;
  let waypoints;
  let snap;
  let staging;
  try {
    vertices = parseRouteVertices(b.vertices);
    waypoints = serializeRouteWaypoints(b.waypoints);
    snap = b.snap === undefined ? false : parseRouteSnap(b.snap);
    staging = parseRouteStaging(b.staging);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const type = isRouteType(b.type) ? b.type : 'sprint';
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO routes (id, owner_id, name, notes, access, type, vertices, waypoints, snap, staging, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, b.name.trim(), String(b.notes ?? ''), String(b.access ?? ''), type,
      JSON.stringify(vertices), waypoints, snap ? 1 : 0, staging ? JSON.stringify(staging) : null, visibility, now, now);
  res.status(201).json(routeJson(db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow));
});

app.get('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(routeJson(row));
});

app.patch('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  let vertices = row.vertices;
  let waypoints = row.waypoints;
  let snap = !!row.snap;
  let staging = row.staging;
  try {
    if (b.vertices !== undefined) vertices = JSON.stringify(parseRouteVertices(b.vertices));
    if (b.waypoints !== undefined) waypoints = serializeRouteWaypoints(b.waypoints);
    if (b.snap !== undefined) snap = parseRouteSnap(b.snap);
    if (b.staging !== undefined) {
      const parsed = parseRouteStaging(b.staging);
      staging = parsed ? JSON.stringify(parsed) : null;
    }
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const next = {
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    access: typeof b.access === 'string' ? b.access : row.access,
    type: isRouteType(b.type) ? b.type : row.type,
    vertices,
    waypoints,
    snap,
    staging,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE routes SET name=?, notes=?, access=?, type=?, vertices=?, waypoints=?, snap=?, staging=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.name, next.notes, next.access, next.type, next.vertices, next.waypoints, next.snap ? 1 : 0, next.staging, next.visibility, new Date().toISOString(), row.id);
  res.json(routeJson(db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(row.id) as unknown as RouteRow));
});

app.delete('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM routes WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- 404 + error handling, then the built frontend -------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.baseUrl}${req.path}` });
});

app.use('/api', (err: Error & { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message || 'Bad request' });
});

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}


export { app };
