import type { Db } from '../db.js';
import { getSettings as getAppSettings, saveAreas, withSwitches } from '../settings.js';
import type { Area, Settings as AppSettings } from '../settings.js';
import { getSettings, saveSettings } from './db.js';
import { bumpEventsVersion } from './events.js';
import { geocode } from './geocode.js';
import type { GeocodeResult } from './geocode.js';
import { countryOf, pickAreaHit } from './locate.js';
import { haversineKm } from './shared/geo.js';
import { bboxCentre, bboxSizeMeters } from './density/geo.js';
import type { DensityArea, Settings } from './sources/types.js';

/**
 * Where the events engine gets its areas.
 *
 * There is one list, PhotoScout's own `home` and `areas`, edited under
 * Settings -> Areas. The engine keeps reading the fields it always read (city,
 * lat, lng, radiusKm, eventAreas, densityAreas) so nothing else in it had to
 * change; this file writes them from that list whenever it is saved and at
 * startup, and nothing else writes them. The engine's own settings route drops
 * them from a body for the same reason.
 *
 * Each area has two switches. `events` puts it in the engine's list to scrape;
 * `busy` puts it in the density areas to sample. The first area that has events
 * on is the engine's city, the rest are its extra areas.
 */

/** A venue-busyness sample is a town, not a region: one page load per venue found. */
export const BUSY_MAX_RADIUS_KM = 10;

/** Two places this close are taken to be one, whatever they are called. */
const SAME_PLACE_KM = 3;

const norm = (name: string): string => name.trim().toLowerCase();

type AreaFields = Pick<Settings, 'city' | 'lat' | 'lng' | 'radiusKm' | 'eventAreas' | 'densityAreas' | 'areasManaged' | 'areaTopics' | 'areaHiddenCategories'>;

/** The engine's area fields for a list of areas. Pure. `current` supplies per-area grid tuning to keep. */
export function engineAreaFields(app: Pick<AppSettings, 'home' | 'areas'>, current: Pick<Settings, 'densityAreas' | 'radiusKm'>): AreaFields {
  const all = [app.home, ...app.areas].map(withSwitches).map((a) => ({ ...a, name: a.name.trim() || 'Area' }));
  const [primary, ...rest] = all.filter((a) => a.events);
  // Per-area overrides for every area with events on, the first included.
  const byName = (field: 'topics' | 'hiddenCategories'): Record<string, string[]> =>
    Object.fromEntries(all.filter((a) => a.events && a[field]?.length).map((a) => [norm(a.name), a[field] as string[]]));
  // A cell or kernel size set for a density area by hand survives the rewrite.
  const tuned = new Map((current.densityAreas ?? []).map((d) => [norm(d.name), d]));
  return {
    city: primary?.name ?? '',
    lat: primary?.lat ?? null,
    lng: primary?.lng ?? null,
    radiusKm: primary?.radiusKm ?? current.radiusKm,
    eventAreas: rest.map((a) => ({ name: a.name, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm })),
    densityAreas: all.filter((a) => a.busy).map((a): DensityArea => {
      const old = tuned.get(norm(a.name));
      return {
        name: a.name, lat: a.lat, lng: a.lng, radiusKm: Math.min(a.radiusKm, BUSY_MAX_RADIUS_KM),
        ...(old?.cellMeters ? { cellMeters: old.cellMeters } : {}),
        ...(old?.kernelMeters ? { kernelMeters: old.kernelMeters } : {}),
      };
    }),
    areasManaged: true,
    areaTopics: byName('topics'),
    areaHiddenCategories: byName('hiddenCategories'),
  };
}

const pick = (s: Settings): AreaFields => ({
  city: s.city, lat: s.lat, lng: s.lng, radiusKm: s.radiusKm,
  eventAreas: s.eventAreas, densityAreas: s.densityAreas, areasManaged: s.areasManaged,
  areaTopics: s.areaTopics ?? {}, areaHiddenCategories: s.areaHiddenCategories ?? {},
});

/**
 * Write the list into the engine's settings, and drop its cached event list if
 * that changed what counts as local. Returns the settings now in force; the
 * caller tells the crawler, so a startup that already does can skip a second call.
 */
export function syncEngineAreas(app: Pick<AppSettings, 'home' | 'areas'>): Settings {
  const current = getSettings();
  const next: Settings = { ...current, ...engineAreaFields(app, current) };
  if (JSON.stringify(pick(current)) !== JSON.stringify(pick(next))) {
    saveSettings(next);
    // Area, place and culled are worked out from the areas on every event.
    bumpEventsVersion();
  }
  return next;
}

/**
 * Bring areas kept only by the engine into PhotoScout's list, once.
 *
 * An event-scout database copied in has its own city, extra areas and density
 * areas, and PhotoScout's list knows none of them. Each that is not already
 * there, by name or by sitting on top of one that is, becomes an area; a density
 * area (or the city, when density ran on it alone) switches busy on for its
 * match. Runs only until the engine's fields have been written from the list
 * (`areasManaged`), so an area removed here does not come back from the old copy.
 *
 * `complete` is false when a name could not be looked up for want of a network:
 * the caller then leaves the engine alone and tries again at the next start,
 * rather than overwrite what it has not yet imported.
 */
export async function importEngineAreas(
  db: Db,
  lookup: (name: string) => Promise<GeocodeResult[]> = geocode,
): Promise<{ imported: string[]; complete: boolean }> {
  const eng = getSettings();
  if (eng.areasManaged) return { imported: [], complete: true };

  const app = getAppSettings(db);
  const home: Area = { ...app.home };
  const areas: Area[] = app.areas.map((a) => ({ ...a }));
  const list = (): Area[] => [home, ...areas];
  const imported: string[] = [];
  let complete = true;
  let changed = false;
  // Names are looked up in the home country first, as refresh does: an old list's
  // "Penrith" is the one down the road, not the one in Cumbria.
  let homeCountry: string | null = null;
  const country = async (): Promise<string> => {
    if (homeCountry === null) {
      try { homeCountry = countryOf((await lookup(eng.city.trim() || app.home.name))[0]?.displayName ?? ''); } catch { homeCountry = ''; }
    }
    return homeCountry;
  };

  const matching = (name: string, lat?: number, lng?: number): Area | undefined =>
    list().find((a) => norm(a.name) === norm(name) ||
      (lat != null && lng != null && haversineKm(a.lat, a.lng, lat, lng) < SAME_PLACE_KM));

  /** The area for one engine-side place: the match, or a new one at its coordinates. */
  const place = async (
    name: string, lat: number | undefined, lng: number | undefined, radiusKm: number | undefined,
    flags: Pick<Area, 'events' | 'busy'>,
  ): Promise<Area | null> => {
    name = name.trim();
    if (!name) return null;
    let found = matching(name, lat, lng);
    if (found) return found;
    if (lat == null || lng == null) {
      try {
        const inCountry = await country();
        const hit = pickAreaHit(await lookup(name), inCountry);
        if (!hit) { console.warn(`Event area "${name}" could not be geocoded; not imported`); return null; }
        ({ lat, lng } = hit);
      } catch (err) {
        console.warn(`Event area "${name}" lookup failed: ${(err as Error).message}`);
        complete = false;
        return null;
      }
      found = matching(name, lat, lng);
      if (found) return found;
    }
    const area: Area = { name, lat, lng, radiusKm: radiusKm && radiusKm > 0 ? Math.min(radiusKm, 1000) : eng.radiusKm, ...flags };
    areas.push(area);
    imported.push(name);
    changed = true;
    return area;
  };

  const city = eng.city.trim();
  if (city) await place(city, eng.lat ?? undefined, eng.lng ?? undefined, eng.radiusKm, { events: true, busy: false });
  for (const a of eng.eventAreas ?? []) await place(a.name ?? '', a.lat, a.lng, a.radiusKm, { events: true, busy: false });

  const dense = eng.densityAreas ?? [];
  for (const d of dense) {
    let { lat, lng, radiusKm } = d;
    if ((lat == null || lng == null) && d.bbox) {
      const c = bboxCentre(d.bbox);
      const size = bboxSizeMeters(d.bbox);
      lat = c.lat; lng = c.lon;
      radiusKm ??= Math.max(size.width, size.height) / 2000;
    }
    const area = await place(d.name ?? '', lat, lng, radiusKm ?? 5.5, { events: false, busy: true });
    if (area && !area.busy) { area.busy = true; changed = true; }
  }
  // Density with no areas of its own sampled the city.
  if (eng.densityEnabled && dense.length === 0 && city) {
    const area = matching(city, eng.lat ?? undefined, eng.lng ?? undefined);
    if (area && !area.busy) { area.busy = true; changed = true; }
  }

  if (changed) saveAreas(db, home, areas);
  return { imported, complete };
}

/**
 * Startup: import what only the engine knew, then write the list in. Does
 * nothing at all when an import could not finish, so the old copy is kept
 * intact for the next start.
 */
export async function startAreas(db: Db, lookup?: (name: string) => Promise<GeocodeResult[]>): Promise<void> {
  const { imported, complete } = await importEngineAreas(db, lookup);
  if (imported.length) console.log(`Imported ${imported.length} area(s) from the events database: ${imported.join(', ')}`);
  if (!complete) {
    console.warn('Some event areas could not be looked up; leaving the events engine as it was until the next start');
    return;
  }
  syncEngineAreas(getAppSettings(db));
}
