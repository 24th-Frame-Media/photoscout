import type {
  PluginEventImporterDef,
  PluginEventLocation,
  PluginEventSourceDef,
  PluginRawEvent,
} from '../plugins/types.js';
import { EVENT_TOPICS, topicsFor } from './sources/topics.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './sources/types.js';

/**
 * Custom event sources and link importers registered by running plugins.
 *
 * Kept in memory and keyed by `plugin:<pluginId>:<id>`, matching `taskRegistry`:
 * when a plugin is disabled, reloaded or uninstalled, its sources and importers
 * are unregistered immediately without restarting the server. Stored event rows
 * keep their `source` column (`plugin:<pluginId>:<id>`) so existing events stay
 * intact across plugin reloads.
 */

const TOPIC_BY_KEY = new Map(EVENT_TOPICS.map((t) => [t.key, t]));

const sources = new Map<string, EventSourceAdapter>();
const importers = new Map<string, { name: string; pluginId: string; label: string; def: PluginEventImporterDef }>();

export function normalizePluginRawEvents(items: readonly PluginRawEvent[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const startTime = typeof item.startTime === 'string' ? item.startTime.trim() : '';
    if (!sourceId || !title || !startTime) continue;
    out.push({
      sourceId,
      title,
      description: typeof item.description === 'string' ? item.description : undefined,
      startTime,
      endTime: typeof item.endTime === 'string' && item.endTime.trim() ? item.endTime.trim() : undefined,
      venueName: typeof item.venueName === 'string' ? item.venueName : undefined,
      address: typeof item.address === 'string' ? item.address : undefined,
      lat: typeof item.lat === 'number' && Number.isFinite(item.lat) ? item.lat : undefined,
      lng: typeof item.lng === 'number' && Number.isFinite(item.lng) ? item.lng : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
      imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : undefined,
      category: typeof item.category === 'string' ? item.category : undefined,
      priceText: typeof item.priceText === 'string' ? item.priceText : undefined,
      isOnline: item.isOnline === true,
      dateOnly: item.dateOnly === true,
    });
  }
  return out;
}

export function buildPluginEventLocation(loc: Location, settings: Settings): PluginEventLocation {
  const activeTopics = topicsFor(settings, loc.city);
  const seenTerms = new Set<string>();
  const terms: string[] = [];
  for (const key of activeTopics) {
    for (const term of TOPIC_BY_KEY.get(key)?.terms ?? []) {
      if (!seenTerms.has(term)) {
        seenTerms.add(term);
        terms.push(term);
      }
    }
  }
  for (const raw of settings.webSearchTerms ?? []) {
    const term = String(raw).trim();
    if (term && !seenTerms.has(term)) {
      seenTerms.add(term);
      terms.push(term);
    }
  }
  const area: PluginEventLocation = {
    city: loc.city,
    lat: loc.lat,
    lng: loc.lng,
    radiusKm: loc.radiusKm,
    ...(loc.queryBudget !== undefined ? { queryBudget: loc.queryBudget } : {}),
    topics: Object.freeze([...activeTopics]),
    terms: Object.freeze(terms),
  };
  return Object.freeze(area);
}

export function registerPluginEventSource(
  pluginId: string,
  pluginName: string,
  def: PluginEventSourceDef,
): string {
  const name = `plugin:${pluginId}:${def.id}`;
  const adapter: EventSourceAdapter = {
    name,
    label: def.label.trim(),
    unofficial: Boolean(def.unofficial),
    description: def.description?.trim() || undefined,
    pluginId,
    pluginName,
    areaScoped: Boolean(def.areaScoped),
    async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
      const area = buildPluginEventLocation(loc, settings);
      let res;
      try {
        res = await def.fetch(area);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'MissingConfigError' || (err as { missingConfig?: boolean }).missingConfig === true)
        ) {
          throw new MissingConfigError(err.message);
        }
        throw err;
      }
      if (res && typeof res === 'object' && !Array.isArray(res) && 'missingConfig' in res) {
        throw new MissingConfigError(String(res.missingConfig || 'Missing configuration'));
      }
      if (!Array.isArray(res)) return [];
      return normalizePluginRawEvents(res);
    },
  };
  sources.set(name, adapter);
  return name;
}

export function unregisterPluginEventSource(name: string): void {
  sources.delete(name);
}

export function getPluginEventSource(name: string): EventSourceAdapter | undefined {
  return sources.get(name);
}

export function listPluginEventSources(): EventSourceAdapter[] {
  return [...sources.values()];
}

export function isAreaScopedPluginSource(name: string): boolean {
  return sources.get(name)?.areaScoped === true;
}

export function registerPluginEventImporter(
  pluginId: string,
  def: PluginEventImporterDef,
): string {
  const name = `plugin:${pluginId}:${def.id}`;
  importers.set(name, { name, pluginId, label: def.label.trim(), def });
  return name;
}

export function unregisterPluginEventImporter(name: string): void {
  importers.delete(name);
}

export async function tryPluginEventImporters(
  url: string,
): Promise<{ label: string; events: RawEvent[] } | null> {
  for (const entry of importers.values()) {
    let matched = false;
    try {
      matched = entry.def.match(url) === true;
    } catch {
      continue;
    }
    if (!matched) continue;
    const raw = await entry.def.read(url);
    if (!raw || !Array.isArray(raw)) continue;
    const events = normalizePluginRawEvents(raw);
    if (events.length > 0) {
      return { label: entry.label, events };
    }
  }
  return null;
}
