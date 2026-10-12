import { Db } from './db.js';

/** Settings kept in kv, plus what an operator may override from the environment. */
export interface Settings {
  home: { name: string; lat: number; lng: number; radiusKm: number };
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
  /** Lets remotes resolve to a private/loopback/link-local IP. For LAN setups. */
  allowPrivateRemotes: boolean;
  eventScoutUrl: string;
  /** event-scout's API token, used by the admin proxy. Never sent to clients; env EVENT_SCOUT_TOKEN wins. */
  eventScoutToken: string;
  /** TfNSW Open Data API key. Never sent to clients; env TFNSW_API_KEY wins. */
  tfnswApiKey: string;
  /** Origins allowed to read the open API from a page served elsewhere. */
  corsOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  home: { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100 },
  areas: [],
  allowPrivateRemotes: false,
  eventScoutUrl: '',
  eventScoutToken: '',
  tfnswApiKey: '',
  corsOrigins: [],
};

export function getSettings(db: Db): Settings {
  const raw = db.getKv('settings');
  const stored = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  // Env wins over what is stored, so an operator can pin these without the UI.
  if (process.env.EVENT_SCOUT_URL) stored.eventScoutUrl = process.env.EVENT_SCOUT_URL;
  if (process.env.TFNSW_API_KEY) stored.tfnswApiKey = process.env.TFNSW_API_KEY;
  if (process.env.EVENT_SCOUT_TOKEN) stored.eventScoutToken = process.env.EVENT_SCOUT_TOKEN;
  delete (stored as Record<string, unknown>).freightSpeedLoadedKmh; // retired with manual sightings
  delete (stored as Record<string, unknown>).freightSpeedEmptyKmh;
  return stored;
}

export function saveSettings(db: Db, settings: Settings): void {
  db.setKv('settings', JSON.stringify(settings));
}

/** The TfNSW API key in effect (env first, then stored), or '' when none. */
export function tfnswKey(db: Db): string {
  return getSettings(db).tfnswApiKey;
}

/** What GET /api/settings returns: everything except the key itself. */
export type PublicSettings = Omit<Settings, 'tfnswApiKey' | 'eventScoutToken'> & {
  tfnswApiKeySet: boolean; tfnswApiKeyFromEnv: boolean; eventScoutTokenSet: boolean; eventScoutTokenFromEnv: boolean;
};

export function publicSettings(settings: Settings): PublicSettings {
  const { tfnswApiKey, eventScoutToken, ...rest } = settings;
  return {
    ...rest,
    tfnswApiKeySet: Boolean(tfnswApiKey), tfnswApiKeyFromEnv: Boolean(process.env.TFNSW_API_KEY),
    eventScoutTokenSet: Boolean(eventScoutToken), eventScoutTokenFromEnv: Boolean(process.env.EVENT_SCOUT_TOKEN),
  };
}

/**
 * What an account that is not an admin is told: where the map opens and
 * which optional feeds are switched on. Not where event-scout lives, which is
 * an address inside the operator's network, nor who may read the API from
 * elsewhere.
 */
export function memberSettings(settings: Settings) {
  return {
    home: settings.home,
    areas: settings.areas,
    tfnswApiKeySet: Boolean(settings.tfnswApiKey),
    eventScoutSet: Boolean(settings.eventScoutUrl),
  };
}

const isArea = (v: unknown): v is Settings['home'] => {
  const a = v as Settings['home'];
  return Boolean(a) && typeof a === 'object' && typeof a.name === 'string' && a.name.length <= 100 &&
    Number.isFinite(a.lat) && Math.abs(a.lat) <= 90 && Number.isFinite(a.lng) && Math.abs(a.lng) <= 180 &&
    Number.isFinite(a.radiusKm) && a.radiusKm > 0 && a.radiusKm <= 1000;
};

/**
 * The settings a PUT may change, each checked. Anything else in the body is
 * dropped: it used to be spread straight into what was stored.
 */
export function cleanSettingsBody(body: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (isArea(body.home)) out.home = { name: body.home.name, lat: body.home.lat, lng: body.home.lng, radiusKm: body.home.radiusKm };
  if (Array.isArray(body.areas) && body.areas.length <= 50 && body.areas.every(isArea)) {
    out.areas = body.areas.map((a) => ({ name: a.name, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm }));
  }
  if (typeof body.allowPrivateRemotes === 'boolean') out.allowPrivateRemotes = body.allowPrivateRemotes;
  if (typeof body.eventScoutUrl === 'string' && body.eventScoutUrl.length <= 500) out.eventScoutUrl = body.eventScoutUrl.trim();
  if (Array.isArray(body.corsOrigins) && body.corsOrigins.length <= 50 && body.corsOrigins.every((o) => typeof o === 'string' && o.length <= 300)) {
    out.corsOrigins = body.corsOrigins as string[];
  }
  return out;
}

/**
 * Apply a PUT body. The key is only replaced by a non-empty string, cleared by
 * `clearTfnswApiKey: true`, and otherwise kept. Returns whether it changed.
 */
export function applySettingsUpdate(db: Db, body: Record<string, unknown>): { settings: Settings; keyChanged: boolean } {
  const raw = db.getKv('settings');
  const stored: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  const { tfnswApiKey, clearTfnswApiKey, tfnswApiKeySet: _s, tfnswApiKeyFromEnv: _e, eventScoutToken, clearEventScoutToken, eventScoutTokenSet: _ts, eventScoutTokenFromEnv: _te, ...rest } = body;
  const next: Settings = { ...stored, ...cleanSettingsBody(rest), tfnswApiKey: stored.tfnswApiKey ?? '', eventScoutToken: stored.eventScoutToken ?? '' };
  // Don't persist env-pinned values as if the user typed them.
  if (process.env.EVENT_SCOUT_URL) next.eventScoutUrl = stored.eventScoutUrl;
  // Same shape as the TfNSW key: replaced by a non-empty string, cleared on request, else kept.
  if (clearEventScoutToken === true) next.eventScoutToken = '';
  else if (typeof eventScoutToken === 'string' && eventScoutToken.trim() && eventScoutToken.length <= 500) next.eventScoutToken = eventScoutToken.trim();
  let keyChanged = false;
  if (clearTfnswApiKey === true) { keyChanged = next.tfnswApiKey !== ''; next.tfnswApiKey = ''; }
  else if (typeof tfnswApiKey === 'string' && tfnswApiKey.trim()) { next.tfnswApiKey = tfnswApiKey.trim(); keyChanged = true; }
  delete (next as unknown as Record<string, unknown>).freightSpeedLoadedKmh;
  delete (next as unknown as Record<string, unknown>).freightSpeedEmptyKmh;
  saveSettings(db, next);
  return { settings: getSettings(db), keyChanged };
}
