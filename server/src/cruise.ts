import { canRead } from './auth.js';
import type { Db } from './db.js';
import { findUserById } from './authStore.js';
import { parseRouteVertices, isRouteType, type RouteRow, type RouteType, type RouteVertex } from './routes.js';

/**
 * A cruise is a community event with a route to drive, a place to meet and a
 * time to roll out. It is kept as one JSON column on the event.
 *
 * The route is a COPY of the line, not a pointer to a saved route. A saved
 * route can be private; an event is read by anyone who has its id. Pointing at
 * the route would either leak it or break for everyone but its owner, so the
 * line is copied onto the event when the organiser attaches it, and only the
 * line: not the route's notes, access remarks or staging point.
 */

export interface Cruise {
  route: { name: string; type: RouteType; vertices: RouteVertex[] };
  meet: { lat: number; lng: number; note: string };
  /** When the cars move off, ISO with a zone. Between the event's start and its end. */
  rollOut: string;
}

/** A snapped route over a long drive is thousands of points; this is far past any real one. */
export const MAX_CRUISE_VERTICES = 10_000;
const MAX_CRUISE_BYTES = 400_000;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_LENGTH_MS = 12 * 3_600_000;

export type CruiseResult = { ok: true; value: Cruise } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * The cruise a request body describes, or why not.
 *
 * `body` is `{ routeId | vertices, name?, type?, meet: { lat, lng, note? }, rollOut }`:
 * a saved route to copy (one the event's organiser can read) or a line drawn
 * for the purpose. With neither, `current` keeps its route, so the meeting
 * point or time can be changed alone. The organiser, not whoever is editing,
 * is the one whose view of the saved routes counts: an admin cannot attach a
 * route the organiser could not have.
 */
export function resolveCruise(
  db: Db, body: unknown, ctx: { ownerId: string; start: string; end: string | null; current: Cruise | null },
): CruiseResult {
  if (!isObject(body)) return fail('cruise must be an object');
  let route: Cruise['route'];
  if (body.routeId !== undefined && body.vertices !== undefined) return fail('Attach a saved route or draw one, not both');
  if (body.routeId !== undefined) {
    if (typeof body.routeId !== 'string' || body.routeId.length > 64) return fail('routeId must be an id');
    const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(body.routeId) as unknown as RouteRow | undefined;
    const owner = findUserById(db, ctx.ownerId);
    // The same answer for "no such route" and "not yours to see", so ids cannot be probed.
    if (!row || !owner || owner.banned || !canRead(row.visibility, row.owner_id, { id: owner.id, role: owner.role })) return fail('No such route');
    route = { name: row.name, type: row.type, vertices: JSON.parse(row.vertices) as RouteVertex[] };
  } else if (body.vertices !== undefined) {
    try { route = { name: '', type: 'sprint', vertices: parseRouteVertices(body.vertices) }; } catch (err) { return fail((err as Error).message); }
  } else if (ctx.current) {
    route = { ...ctx.current.route };
  } else {
    return fail('Choose a saved route or draw one');
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return fail('name must be text');
    route.name = body.name.trim();
  }
  if (body.type !== undefined) {
    if (!isRouteType(body.type)) return fail('type must be sprint or circuit');
    route.type = body.type;
  }
  route.name = route.name.slice(0, 100) || 'Cruise route';
  if (route.vertices.length < 2) return fail('A route needs at least two points');
  if (route.vertices.length > MAX_CRUISE_VERTICES) return fail(`A route can have ${MAX_CRUISE_VERTICES} points at most`);
  route.vertices = route.vertices.map(([lng, lat]): RouteVertex => [round6(lng), round6(lat)]);
  if (JSON.stringify(route.vertices).length > MAX_CRUISE_BYTES) return fail('That route is too large');

  const m = body.meet === undefined ? ctx.current?.meet : body.meet;
  if (!isObject(m)) return fail('Set a meeting point');
  const lat = m.lat, lng = m.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return fail('The meeting point needs a latitude and longitude');
  }
  const note = m.note === undefined || m.note === null ? '' : m.note;
  if (typeof note !== 'string' || note.trim().length > 200) return fail('The meeting note is text of at most 200 characters');

  const rawRoll = body.rollOut === undefined ? ctx.current?.rollOut : body.rollOut;
  if (typeof rawRoll !== 'string' || !ISO_WITH_ZONE.test(rawRoll) || !Number.isFinite(Date.parse(rawRoll))) {
    return fail('rollOut must be a date and time in ISO form, with its zone');
  }
  const roll = Date.parse(rawRoll);
  const start = Date.parse(ctx.start);
  const end = ctx.end ? Date.parse(ctx.end) : start + DEFAULT_LENGTH_MS;
  if (roll < start || roll >= end) return fail('The roll-out time has to fall while the event is on');

  return { ok: true, value: { route, meet: { lat, lng, note: note.trim() }, rollOut: new Date(roll).toISOString() } };
}

export function readCruise(raw: string | null | undefined): Cruise | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as Cruise; } catch { return null; }
}

/**
 * The cruise as the API shows it. A list of events leaves the line out
 * (`full` false): it is the bulk of the bytes, and a list only needs to say there is a cruise.
 */
export function cruiseJson(cruise: Cruise | null, full: boolean) {
  if (!cruise) return null;
  return {
    route: { name: cruise.route.name, type: cruise.route.type, ...(full ? { vertices: cruise.route.vertices } : {}) },
    meet: cruise.meet,
    rollOut: cruise.rollOut,
  };
}

/**
 * Whether `userId` may start or join this cruise's convoy, and what it starts with.
 * The organiser starts it; anyone who has said they are going joins it. The
 * event has to be on, shown, and have a cruise.
 */
export function cruiseAccess(db: Db, eventId: string, userId: string, now = Date.now()):
  { ok: true; title: string; isOwner: boolean; meet: Cruise['meet'] } | { ok: false; error: string } {
  const r = db.handle.prepare(
    `SELECT e.owner_id, e.title, e.start_time, e.end_time, e.hidden, e.cruise, u.banned,
            EXISTS (SELECT 1 FROM community_rsvps s WHERE s.event_id = e.id AND s.user_id = ?) AS going
       FROM community_events e JOIN users u ON u.id = e.owner_id WHERE e.id = ?`
  ).get(userId, eventId) as { owner_id: string; title: string; start_time: string; end_time: string | null; hidden: number; cruise: string | null; banned: number; going: number } | undefined;
  const cruise = readCruise(r?.cruise);
  if (!r || !cruise || r.hidden === 1 || r.banned === 1) return fail('No such cruise');
  const end = r.end_time ? Date.parse(r.end_time) : Date.parse(r.start_time) + DEFAULT_LENGTH_MS;
  if (end <= now) return fail('That cruise is over');
  const isOwner = r.owner_id === userId;
  if (!isOwner && r.going !== 1) return fail('Say you are going to join the convoy');
  return { ok: true, title: r.title, isOwner, meet: cruise.meet };
}
