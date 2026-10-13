import { CODE_PATTERN, MAX_LABEL, MAX_NAME, normalizeCode } from './convoy.js';

/**
 * What a client may say on the socket, checked field by field before anything
 * acts on it. Every message is one JSON object with a `t` that names it; a
 * field that is not listed is dropped, a listed one that is the wrong shape
 * refuses the whole message.
 */

/** Metres per second: about 430 km/h, above which a "speed" is a bad sensor or somebody's idea of a joke. */
const MAX_SPEED = 120;

export type ClientMessage =
  | { t: 'chat.sub' }
  | { t: 'chat.unsub' }
  | { t: 'convoy.create'; name: string }
  | { t: 'convoy.join'; code: string }
  | { t: 'convoy.cruise'; eventId: string }
  | { t: 'convoy.leave'; room: string }
  | { t: 'convoy.dest'; room: string; destination: { lat: number; lng: number; label: string } | null }
  | { t: 'convoy.lead'; room: string; to: string }
  | { t: 'convoy.remove'; room: string; id: string }
  | { t: 'pos.stop' }
  | { t: 'pos'; lat: number; lng: number; heading: number | null; speed: number | null };

export type ParsedMessage = { ok: true; message: ClientMessage } | { ok: false; error: string };

class Bad extends Error {}
const bad = (message: string): never => { throw new Bad(message); };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(o: Record<string, unknown>, field: string, min: number, max: number): number {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(`${field} must be a number from ${min} to ${max}`);
  return v;
}

/** A number, or null for "the device does not know". */
function maybeNum(o: Record<string, unknown>, field: string, min: number, max: number): number | null {
  return o[field] === undefined || o[field] === null ? null : num(o, field, min, max);
}

function str(o: Record<string, unknown>, field: string, max: number, required = false): string {
  const v = o[field] ?? '';
  if (typeof v !== 'string') return bad(`${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(`${field} is required`);
  if (t.length > max) return bad(`${field} is too long`);
  return t;
}

const id = (o: Record<string, unknown>, field: string): string => str(o, field, 64, true);

export function parseClientMessage(raw: string): ParsedMessage {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { ok: false, error: 'Messages are JSON' }; }
  if (!isObject(o) || typeof o.t !== 'string') return { ok: false, error: 'Expected an object with a t' };
  try {
    switch (o.t) {
      case 'chat.sub':
      case 'chat.unsub':
      case 'pos.stop':
        return { ok: true, message: { t: o.t } };
      case 'convoy.create':
        return { ok: true, message: { t: o.t, name: str(o, 'name', MAX_NAME) } };
      case 'convoy.join': {
        const code = normalizeCode(str(o, 'code', 32, true));
        if (!CODE_PATTERN.test(code)) return bad('That is not a convoy code');
        return { ok: true, message: { t: o.t, code } };
      }
      case 'convoy.cruise':
        return { ok: true, message: { t: o.t, eventId: id(o, 'eventId') } };
      case 'convoy.leave':
        return { ok: true, message: { t: o.t, room: id(o, 'room') } };
      case 'convoy.dest': {
        let destination: { lat: number; lng: number; label: string } | null = null;
        if (o.destination !== null && o.destination !== undefined) {
          if (!isObject(o.destination)) return bad('destination must be an object or null');
          destination = { lat: num(o.destination, 'lat', -90, 90), lng: num(o.destination, 'lng', -180, 180), label: str(o.destination, 'label', MAX_LABEL) };
        }
        return { ok: true, message: { t: o.t, room: id(o, 'room'), destination } };
      }
      case 'convoy.remove':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), id: id(o, 'id') } };
      case 'convoy.lead':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), to: id(o, 'to') } };
      case 'pos':
        return { ok: true, message: { t: o.t, lat: num(o, 'lat', -90, 90), lng: num(o, 'lng', -180, 180), heading: maybeNum(o, 'heading', 0, 360), speed: maybeNum(o, 'speed', 0, MAX_SPEED) } };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  } catch (err) {
    if (err instanceof Bad) return { ok: false, error: err.message };
    throw err;
  }
}
