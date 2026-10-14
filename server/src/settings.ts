import { Db } from './db.js';

/**
 * A place the app looks around. The map and feeds always use it; the switches
 * say whether the events engine scrapes events here and whether it tracks how
 * busy venues are. Both are written out on read, so an area saved before they
 * existed comes back as events on, busy off.
 */
export interface Area {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
  events: boolean;
  busy: boolean;
  /** Topic keys to search this area for. Empty or missing: the engine's global topics. */
  topics?: string[];
  /** Categories hidden for events in this area, on top of the engine's global list. */
  hiddenCategories?: string[];
}

/** Settings kept in kv, plus what an operator may override from the environment. */
export interface Settings {
  /** The first area. Where the map opens. */
  home: Area;
  /** The others. The only place any area is edited: the events engine's own copy is derived from these. */
  areas: Area[];
  /** Lets remotes resolve to a private/loopback/link-local IP. For LAN setups. */
  allowPrivateRemotes: boolean;
  /** TfNSW Open Data API key. Never sent to clients; env TFNSW_API_KEY wins. */
  tfnswApiKey: string;
  /** Origins allowed to read the open API from a page served elsewhere. */
  corsOrigins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  home: { name: 'Bathurst', lat: -33.419, lng: 149.577, radiusKm: 100, events: true, busy: false },
  areas: [],
  allowPrivateRemotes: false,
  tfnswApiKey: '',
  corsOrigins: [],
};

/** An area with both switches written out: events on and busy off unless it says otherwise. */
export function withSwitches<T extends { events?: boolean; busy?: boolean }>(a: T): T & { events: boolean; busy: boolean } {
  return { ...a, events: a.events !== false, busy: a.busy === true };
}

export function getSettings(db: Db): Settings {
  const raw = db.getKv('settings');
  const stored = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  stored.home = withSwitches(stored.home);
  stored.areas = (stored.areas ?? []).map(withSwitches);
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

/**
 * Store a new home and list of areas and nothing else. Read from the raw row,
 * not getSettings, so a key an operator set in the environment is not written
 * into the database on the way through.
 */
export function saveAreas(db: Db, home: Area, areas: Area[]): void {
  const raw = db.getKv('settings');
  const stored: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  saveSettings(db, { ...stored, home: withSwitches(home), areas: areas.map(withSwitches) });
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

/** A list of short trimmed strings, empties and repeats dropped; undefined when it is not a list or ends up empty. */
const cleanList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 60)).filter(Boolean))].slice(0, 100);
  return out.length ? out : undefined;
};

const isArea = (v: unknown): v is Area => {
  const a = v as Area;
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
  const clean = (a: Area): Area => {
    const topics = cleanList(a.topics);
    const hiddenCategories = cleanList(a.hiddenCategories);
    return withSwitches({
      name: a.name, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm, events: a.events, busy: a.busy,
      ...(topics ? { topics } : {}), ...(hiddenCategories ? { hiddenCategories } : {}),
    });
  };
  if (isArea(body.home)) out.home = clean(body.home);
  if (Array.isArray(body.areas) && body.areas.length <= 50 && body.areas.every(isArea)) out.areas = body.areas.map(clean);
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
export function applySettingsUpdate(db: Db, body: Record<string, unknown>): { settings: Settings; keyChanged: boolean; areasChanged: boolean } {
  const raw = db.getKv('settings');
  const stored: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  const areasBefore = JSON.stringify([withSwitches(stored.home), (stored.areas ?? []).map(withSwitches)]);
  const { tfnswApiKey, clearTfnswApiKey, tfnswApiKeySet: _s, tfnswApiKeyFromEnv: _e, ...rest } = body;
  const next: Settings = { ...stored, ...cleanSettingsBody(rest), tfnswApiKey: stored.tfnswApiKey ?? '' };

  let keyChanged = false;
  if (clearTfnswApiKey === true) { keyChanged = next.tfnswApiKey !== ''; next.tfnswApiKey = ''; }
  else if (typeof tfnswApiKey === 'string' && tfnswApiKey.trim()) { next.tfnswApiKey = tfnswApiKey.trim(); keyChanged = true; }
  delete (next as unknown as Record<string, unknown>).freightSpeedLoadedKmh;
  delete (next as unknown as Record<string, unknown>).freightSpeedEmptyKmh;
  saveSettings(db, next);
  const settings = getSettings(db);
  return { settings, keyChanged, areasChanged: JSON.stringify([settings.home, settings.areas]) !== areasBefore };
}
