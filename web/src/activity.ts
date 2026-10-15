/** Local, bounded activity history. Never records URLs, credentials or response bodies. */
export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';
export interface ActivityEntry { id: number; at: number; service: string; message: string; level: ActivityLevel; repeats: number }
let entries: ActivityEntry[] = [];
let serial = 0;
const listeners = new Set<() => void>();
export const activitySnapshot = () => entries;
export const subscribeActivity = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** A successful request slower than this is logged, so a sluggish service shows without logging every normal load. */
const SLOW_MS = 4000;
/** Services that have loaded successfully this page session. Clearing the list does not reset this. */
const loadedServices = new Set<string>();
/** Services whose latest outcome was an error or a warning, so their next success is news. */
const troubledServices = new Set<string>();

export function logActivity(service: string, message: string, level: ActivityLevel = 'info') {
  const previous = entries.find(entry => entry.service === service);
  const repeat = previous?.message === message && previous.level === level;
  const entry = { id: ++serial, at: Date.now(), service, message, level, repeats: repeat ? previous.repeats + 1 : 1 };
  entries = [entry, ...entries.filter(item => !repeat || item.id !== previous.id)].slice(0, 80);
  if (level === 'error' || level === 'warning') troubledServices.add(service);
  else troubledServices.delete(service);
  listeners.forEach(listener => listener());
}

/**
 * A success that a routine refresh repeats. It is news the first time a service loads this session and
 * the first time it succeeds after an error or warning; every other success stays out of the log.
 */
export function logSuccessIfNews(service: string, message: string): boolean {
  const recovering = troubledServices.has(service);
  const news = recovering || !loadedServices.has(service);
  loadedServices.add(service);
  if (news) logActivity(service, recovering ? 'Working again' : message, 'success');
  return news;
}
export function clearActivity() { entries = []; listeners.forEach(listener => listener()); }

export function activityService(url: string): string | null {
  const path = url.split('?')[0];
  const names: Record<string, string> = {
    weather: 'Weather', marine: 'Tides and swell', fires: 'Fire incidents', aurora: 'Aurora', planes: 'Flights',
    rail: 'Rail network', trains: 'Trains', cameras: 'Traffic cameras', radio: 'Radio', events: 'Events',
    'community-events': 'Community events', candidates: 'Points of interest', roads: 'Road quality',
    buildings: 'Buildings', places: 'Places', spots: 'Spots', routes: 'Routes', geocode: 'Place search',
  };
  if (path.startsWith('/api/events-admin/')) {
    const engineNames: Record<string, string> = { crawler: 'Crawler', density: 'Busy places', llm: 'AI models', vision: 'Photo analysis',
      notify: 'Notifications', tasks: 'Scheduled tasks', photo: 'Photo conditions', events: 'Events', settings: 'Events settings' };
    return engineNames[path.split('/')[3]] ?? 'Events engine';
  }
  return names[path.split('/')[2]] ?? null;
}

const latestRequests = new Map<string, number>();
let requestSerial = 0;
/** A wrapper used by API clients, without patching global fetch. Aborted pans are silent. */
export async function activityFetch(url: string, init?: RequestInit): Promise<Response> {
  const service = activityService(url);
  if (!service) return fetch(url, init);
  const request = ++requestSerial;
  latestRequests.set(service, request);
  // The Activity panel's own status polls report their outcome themselves, so a successful poll is not logged here.
  const statusRead = /^\/api\/events-admin\/(?:status|(?:crawler|density|notify|llm)\/status|tasks)(?:\?|$)/.test(url);
  const started = Date.now();
  const isLatest = () => !init?.signal?.aborted && latestRequests.get(service) === request;
  try {
    const response = await fetch(url, init);
    const elapsed = Date.now() - started;
    // These feeds can successfully answer with an explicit configuration gap.
    // Read only that flag, preserving the response and excluding its contents
    // from the history. A transport success alone does not mean they are ready.
    let unconfigured = false;
    if (response.ok && (service === 'Trains' || service === 'Traffic cameras')) {
      const payload = await response.clone().json().catch(() => null);
      unconfigured = payload?.configured === false;
    }
    if (isLatest()) {
      if (!response.ok || unconfigured) {
        const busy = response.status === 429;
        logActivity(service, unconfigured ? 'Needs configuration in Settings' : busy ? 'Busy; try again shortly' : 'Unavailable right now; try again later',
          unconfigured || busy ? 'warning' : 'error');
      } else {
        if (!statusRead) logSuccessIfNews(service, 'Loaded');
        if (elapsed > SLOW_MS) logActivity(service, `Loaded slowly (${Math.round(elapsed / 1000)} s)`, 'info');
      }
    }
    return response;
  } catch (error) {
    if (isLatest()) logActivity(service, 'Connection failed', 'error');
    throw error;
  }
}
