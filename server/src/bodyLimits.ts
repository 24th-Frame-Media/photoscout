/**
 * The first thing wrong with a place, spot or route body, or null.
 *
 * Only shapes and sizes: a name that is a number, notes the length of a novel,
 * a latitude of 400. Whether a field is required is the handler's business.
 */
const TEXT_LIMITS: Record<string, number> = { name: 200, notes: 10_000, access: 2_000, caption: 2_000 };
const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 50;
/** A route or an outline, serialised. Generous: a long road-snapped route is tens of kilobytes. */
const MAX_SHAPE_BYTES = 500_000;

export function bodyProblem(body: Record<string, unknown>): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Expected a JSON object';
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${field} must be text`;
    if (value.length > max) return `${field} is too long (${max} characters at most)`;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS) return `tags must be a list of at most ${MAX_TAGS}`;
    if (!body.tags.every((t) => typeof t === 'string' && t.length <= MAX_TAG_LENGTH)) return `each tag must be text of at most ${MAX_TAG_LENGTH} characters`;
  }
  for (const [field, max] of [['lat', 90], ['lng', 180]] as const) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) return `${field} is out of range`;
  }
  for (const field of ['geom', 'vertices', 'waypoints', 'staging', 'goodTimes']) {
    if (body[field] !== undefined && JSON.stringify(body[field]).length > MAX_SHAPE_BYTES) return `${field} is too large`;
  }
  return null;
}

// --- profiles, the Kit and community events ---------------------------------
//
// Each parser takes the request body and, for an edit, the row as it is now:
// fields left out keep their value, and the merged result is checked as a
// whole, so a PATCH can never leave a row that a POST would have refused.
// Unknown fields are ignored; unknown values of a known field are refused.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

class FieldError extends Error {}
const bad = (message: string): never => { throw new FieldError(message); };

function parsed<T>(body: unknown, build: (b: Record<string, unknown>) => T): Parsed<T> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object' };
  try {
    return { ok: true, value: build(body as Record<string, unknown>) };
  } catch (err) {
    if (err instanceof FieldError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Trimmed text of at most `max` characters. Left out keeps `current`; with no `current` it is required. */
function text(b: Record<string, unknown>, field: string, max: number, current: string | undefined, required = false): string {
  let v = b[field];
  if (v === undefined) {
    if (current === undefined) return bad(`${field} is required`);
    return current;
  }
  if (v === null && !required) v = '';
  if (typeof v !== 'string') return bad(`${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(`${field} is required`);
  if (t.length > max) return bad(`${field} is too long (${max} characters at most)`);
  return t;
}

function oneOf<T extends string>(b: Record<string, unknown>, field: string, allowed: readonly T[], current: T | undefined): T {
  const v = b[field];
  if (v === undefined && current !== undefined) return current;
  return allowed.includes(v as T) ? (v as T) : bad(`${field} must be one of: ${allowed.join(', ')}`);
}

function number(b: Record<string, unknown>, field: string, min: number, max: number, current: number | undefined): number {
  const v = b[field] === undefined ? current : b[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(`${field} must be a number from ${min} to ${max}`);
  return v;
}

/** An Instagram handle, never a URL: letters, digits, dots and underscores, one leading @ forgiven. */
export const INSTAGRAM = /^(?!\.+$)[A-Za-z0-9._]{1,30}$/;
export const MAX_BIO = 500;

export interface ProfileInput { bio?: string; instagram?: string }

/** What `PATCH /api/auth/me` may change besides the handle. Nothing sent is not an error here: the handle may be all there is. */
export function parseProfile(body: unknown): Parsed<ProfileInput> {
  return parsed(body, (b) => {
    const out: ProfileInput = {};
    if (b.bio !== undefined) out.bio = text(b, 'bio', MAX_BIO, undefined);
    if (b.instagram !== undefined) {
      const raw = b.instagram === null ? '' : b.instagram;
      if (typeof raw !== 'string') return bad('instagram must be text');
      const handle = raw.trim().replace(/^@/, '');
      if (handle && !INSTAGRAM.test(handle)) return bad('instagram is a handle: up to 30 letters, digits, dots or underscores');
      out.instagram = handle;
    }
    return out;
  });
}

export const RIDE_KINDS = ['car', 'motorbike'] as const;
export const GEAR_KINDS = ['camera', 'lens', 'other'] as const;
export const EVENT_VISIBILITIES = ['public', 'unlisted'] as const;

export interface RideInput { kind: typeof RIDE_KINDS[number]; make: string; model: string; year: number | null; nickname: string; notes: string }

export function parseRide(body: unknown, current?: RideInput, now = new Date()): Parsed<RideInput> {
  return parsed(body, (b) => {
    let year = current?.year ?? null;
    if (b.year !== undefined) year = b.year === null ? null : number(b, 'year', 1886, now.getFullYear() + 1, undefined);
    if (year !== null && !Number.isInteger(year)) bad('year must be a whole number');
    return {
      kind: oneOf(b, 'kind', RIDE_KINDS, current?.kind),
      make: text(b, 'make', 60, current?.make, true),
      model: text(b, 'model', 60, current?.model, true),
      year,
      nickname: text(b, 'nickname', 60, current?.nickname ?? ''),
      notes: text(b, 'notes', 2000, current?.notes ?? ''),
    };
  });
}

export interface GearInput { kind: typeof GEAR_KINDS[number]; brand: string; name: string; notes: string }

export function parseGear(body: unknown, current?: GearInput): Parsed<GearInput> {
  return parsed(body, (b) => ({
    kind: oneOf(b, 'kind', GEAR_KINDS, current?.kind),
    brand: text(b, 'brand', 60, current?.brand, true),
    name: text(b, 'name', 100, current?.name, true),
    notes: text(b, 'notes', 500, current?.notes ?? ''),
  }));
}

export interface CommunityEventInput {
  title: string; description: string; startTime: string; endTime: string | null; venueName: string; address: string;
  lat: number; lng: number; priceText: string; visibility: typeof EVENT_VISIBILITIES[number];
}

export const MAX_EVENT_DAYS_AHEAD = 400;
export const MAX_EVENT_DAYS_LONG = 14;
const DAY_MS = 86_400_000;
/** A date and time that says its zone, so the server never guesses one. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function instant(b: Record<string, unknown>, field: string): string {
  const v = b[field];
  const ms = typeof v === 'string' && ISO_WITH_ZONE.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) return bad(`${field} must be a date and time in ISO form, with its zone`);
  return new Date(ms).toISOString();
}

/**
 * A community event. The start has to be ahead of `now` and within 400 days
 * when it is new or being moved; an event already under way keeps its start
 * through an edit of anything else.
 */
export function parseCommunityEvent(body: unknown, now: number, current?: CommunityEventInput): Parsed<CommunityEventInput> {
  return parsed(body, (b) => {
    const startTime = b.startTime === undefined && current ? current.startTime : instant(b, 'startTime');
    const start = Date.parse(startTime);
    if (!current || startTime !== current.startTime) {
      if (start <= now) bad('startTime must be in the future');
      if (start > now + MAX_EVENT_DAYS_AHEAD * DAY_MS) bad(`startTime must be within ${MAX_EVENT_DAYS_AHEAD} days`);
    }
    let endTime = current?.endTime ?? null;
    if (b.endTime !== undefined) endTime = b.endTime === null || b.endTime === '' ? null : instant(b, 'endTime');
    if (endTime !== null) {
      const end = Date.parse(endTime);
      if (end <= start) bad('endTime must be after startTime');
      if (end - start > MAX_EVENT_DAYS_LONG * DAY_MS) bad(`an event can run ${MAX_EVENT_DAYS_LONG} days at most`);
    }
    return {
      title: text(b, 'title', 150, current?.title, true),
      description: text(b, 'description', 4000, current?.description ?? ''),
      startTime,
      endTime,
      venueName: text(b, 'venueName', 150, current?.venueName ?? ''),
      address: text(b, 'address', 300, current?.address ?? ''),
      lat: number(b, 'lat', -90, 90, current?.lat),
      lng: number(b, 'lng', -180, 180, current?.lng),
      priceText: text(b, 'priceText', 60, current?.priceText ?? ''),
      visibility: oneOf(b, 'visibility', EVENT_VISIBILITIES, current?.visibility ?? 'public'),
    };
  });
}
