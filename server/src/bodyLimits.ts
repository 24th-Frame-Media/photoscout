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
