import { Db } from './db.js';

/** Settings kept in kv, plus what an operator may override from the environment. */
export interface Settings {
  home: { name: string; lat: number; lng: number; radiusKm: number };
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
  /** Lets remotes resolve to a private/loopback/link-local IP. For LAN setups. */
  allowPrivateRemotes: boolean;
  /** TfNSW Open Data API key. Never sent to clients; env TFNSW_API_KEY wins. */
  tfnswApiKey: string;
  /** Origins allowed to read the open API from a page served elsewhere. */
  corsOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  home: { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100 },
  areas: [],
  allowPrivateRemotes: false,
  tfnswApiKey: '',
  corsOrigins: [],
};

export function getSettings(db: Db): Settings {
  const raw = db.getKv('settings');
  const stored = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  // Env wins over what is stored, so an operator can pin these without the UI.
  if (process.env.TFNSW_API_KEY) stored.tfnswApiKey = process.env.TFNSW_API_KEY;
  delete (stored as Record<string, unknown>).freightSpeedLoadedKmh; // retired with manual sightings
  delete (stored as Record<string, unknown>).freightSpeedEmptyKmh;
  delete (stored as Record<string, unknown>).eventScoutUrl; // the events engine runs in this process now
  delete (stored as Record<string, unknown>).eventScoutToken;
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
export type PublicSettings = Omit<Settings, 'tfnswApiKey'> & { tfnswApiKeySet: boolean; tfnswApiKeyFromEnv: boolean };

export function publicSettings(settings: Settings): PublicSettings {
  const { tfnswApiKey, ...rest } = settings;
  return {
    ...rest,
    tfnswApiKeySet: Boolean(tfnswApiKey), tfnswApiKeyFromEnv: Boolean(process.env.TFNSW_API_KEY),
  };
}

/**
 * What an account that is not an admin is told: where the map opens and
 * which optional feeds are switched on. Not who may read the API from elsewhere.
 */
export function memberSettings(settings: Settings) {
  return {
    home: settings.home,
    areas: settings.areas,
    tfnswApiKeySet: Boolean(settings.tfnswApiKey),
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
  const { tfnswApiKey, clearTfnswApiKey, tfnswApiKeySet: _s, tfnswApiKeyFromEnv: _e, ...rest } = body;
  const next: Settings = { ...stored, ...cleanSettingsBody(rest), tfnswApiKey: stored.tfnswApiKey ?? '' };

  let keyChanged = false;
  if (clearTfnswApiKey === true) { keyChanged = next.tfnswApiKey !== ''; next.tfnswApiKey = ''; }
  else if (typeof tfnswApiKey === 'string' && tfnswApiKey.trim()) { next.tfnswApiKey = tfnswApiKey.trim(); keyChanged = true; }
  delete (next as unknown as Record<string, unknown>).freightSpeedLoadedKmh;
  delete (next as unknown as Record<string, unknown>).freightSpeedEmptyKmh;
  saveSettings(db, next);
  return { settings: getSettings(db), keyChanged };
}
