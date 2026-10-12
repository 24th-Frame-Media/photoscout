import { AREA_SLACK, haversineKm } from './shared/geo.js';
import { regionName } from './regions.js';

/**
 * Which events to keep out of sight on their own.
 *
 * Two rules switched from Settings — an event well outside every area being
 * searched, and an event in a category nobody asked for — and two from the
 * model's vet job: a listing it says is not an event, and a new one it has
 * not read yet. Worked out each
 * time the list is read rather than stored, so changing an area or a category
 * puts back everything the old setting took away — nothing here is a decision
 * that has to be undone by hand, and nothing is ever deleted.
 *
 * Kept out of reach of both rules:
 *
 *   - a starred event, which somebody has already said they want;
 *   - one added by hand from a link, for the same reason;
 *   - one with no place at all that something else says is local. See
 *     unplacedReason;
 *   - for the category rule, one whose category was set by hand.
 *
 * Pure, so every one of those can be tested without a database.
 */

export interface Cullable {
  lat: number | null;
  lng: number | null;
  locality: string;
  /**
   * The searched area it is in, '' when none. Not the heading it is listed
   * under: a town with enough listings gets a heading of its own however far
   * away it is, and Armidale's did, 330 km from Bathurst.
   */
  area: string;
  category: string;
  starred: boolean;
  unknownLocation: boolean;
  sources: { source: string; url?: string }[];
  edited: string[];
  /** The model's reason this is not an event at all, '' when it is or has not said. */
  notEvent?: string;
  /** New, and not yet checked by the model. See vetting in events.ts. */
  pending?: boolean;
  /** The region the listing names ('qld'), '' when it names none. */
  region?: string;
  /** The event title, used for rule-based non-event detection. */
  title?: string;
  /** The event description, used for rule-based non-event detection. */
  description?: string;
  /** Its site's other listings are nearly all inside an area. See localSites in events.ts. */
  localSite?: boolean;
  /** The model is checking listings and has not passed this one. */
  unvetted?: boolean;
}

/**
 * Rule-based detection of non-event listings.
 *
 * Returns a human-readable reason string when the listing is clearly not a
 * genuine event (homepage, contact page, volunteer application, etc.), or null
 * when no rule fires and the listing may be a real event.
 *
 * Does NOT fire on root-path URLs alone — many real event websites use their
 * root URL as the canonical event page (e.g. challengebathurst.com/).
 * Homepage detection requires a homepage-style title as well.
 */
export function detectNotAnEvent(title?: string, description?: string, url?: string): string | null {
  const t = (title ?? '').trim();
  const tLc = t.toLowerCase();

  // Homepages: title must match a homepage pattern (root URL alone is not enough,
  // as real events like challengebathurst.com use their root as the event page).
  if (/^home\s*[-|–—:]/i.test(t)) return 'Homepage title';
  if (/^welcome\s+to\s+/i.test(t)) return 'Homepage title';
  if (/^homepage\b/i.test(t)) return 'Homepage title';

  // Site information & contact pages — exact title matches
  const exactNonEvent = [
    'contact', 'contact us', 'about', 'about us',
    'terms', 'terms and conditions', 'privacy policy', 'privacy',
  ];
  if (exactNonEvent.includes(tLc)) return 'Site information page';

  // Site information & contact pages — URL path segments
  if (url) {
    try {
      const path = new URL(url).pathname;
      if (/\/(contact|about-us|privacy|terms)(\/|$)/i.test(path)) return 'Site information page';
    } catch { /* invalid URL, skip */ }
  }

  // Volunteer / staff recruitment & applications
  const volunteerPhrases = [
    'volunteer application', 'volunteers needed', 'call for volunteers',
    'officials & volunteers', 'officials and volunteers', 'volunteering calendar',
    'volunteer resources', 'officials application', 'marshals wanted', 'marshals application',
  ];
  for (const phrase of volunteerPhrases) {
    if (tLc.includes(phrase)) return 'Volunteer or staff recruitment page';
  }

  // Vendor / stallholder / grant applications
  const vendorPhrases = [
    'stallholders application', 'stallholder application', 'vendor application',
    'exhibitor application', 'stallholder info', 'stallholder packages',
    'grant application', 'grants application', 'scholarship application',
  ];
  for (const phrase of vendorPhrases) {
    if (tLc.includes(phrase)) return 'Vendor or application page';
  }

  // A site's own listing of events, which is a page about events and not one.
  if (/^(events?|event calendar|events calendar|calendar|what'?s on|upcoming events)(\s*[|–—-]|$)/i.test(t)) {
    return 'Events index page, not an event';
  }

  // Standalone navigation-only section titles
  const navSections = ['stallholders', 'sponsors', 'volunteers', 'officials', 'marshals'];
  if (navSections.includes(tLc)) return 'Site navigation section, not an event';

  // News articles / race recaps identified by URL path + title keywords
  if (url) {
    try {
      const path = new URL(url).pathname;
      if (/\/(news|blog|press)(\/|$)/i.test(path)) {
        const recapKeywords = [
          'recap', 'results', 'breakthrough', 'at odds', 'health update',
          'clash', 'emotional', 'stunned', 'delighted',
        ];
        for (const kw of recapKeywords) {
          if (tLc.includes(kw)) return 'News article or race recap';
        }
      }
    } catch { /* invalid URL, skip */ }
  }

  return null;
}

export interface CullHub {
  name: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number;
}

export interface CullRules {
  cullOutsideAreas?: boolean;
  excludedCategories?: string[];
  /** The regions the searched areas are in. Empty switches the region rule off. */
  areaRegions?: string[];
}

/** Why this event is out of sight, or null when it is not. */
export function cullReason(
  ev: Cullable,
  hubs: CullHub[],
  rules: CullRules,
  positionsOf: (name: string) => { lat: number; lng: number }[] = () => []
): string | null {
  if (ev.starred) return null;
  if (ev.sources.some((s) => s.source === 'manual')) return null;
  const nonEventReason = detectNotAnEvent(ev.title, ev.description, ev.sources[0]?.url);
  if (nonEventReason) return `Not an event: ${nonEventReason}`;
  if (ev.notEvent) return `Not an event: ${ev.notEvent}`;
  if (ev.pending && !ev.area) return 'Waiting to be checked';

  const excluded = new Set((rules.excludedCategories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (excluded.has(ev.category.trim().toLowerCase()) && !ev.edited.includes('category')) {
    return `Excluded category: ${ev.category}`;
  }

  if (!rules.cullOutsideAreas || ev.area) return null;
  // The region it names, when that is a region none of the areas are in. No
  // lookup needed, and it catches what a lookup often cannot: a listing whose
  // town was never found, or was found in the wrong state.
  const regions = rules.areaRegions ?? [];
  if (ev.region && regions.length > 0 && !regions.includes(ev.region)) {
    return `In ${regionName(ev.region)}, outside every area`;
  }
  // Where it is: its own coordinates, else every place its town's name was
  // found when it was last looked up. Nothing is looked up here — an event
  // that cannot be put on the map without a request is one that cannot be
  // judged, and is left alone. A town name that also exists inside an area
  // counts as inside: Kelso is a suburb of Bathurst as well as a Scottish
  // town, and hiding a local event on a namesake's account is the worse error.
  const points =
    ev.lat != null && ev.lng != null ? [{ lat: ev.lat, lng: ev.lng }] : ev.locality ? positionsOf(ev.locality) : [];
  const positioned = hubs.filter((h) => h.lat != null && h.lng != null);
  if (positioned.length === 0) return null;
  if (points.length === 0) return unplacedReason(ev, hubs);

  let nearest: { hub: CullHub; km: number } | null = null;
  for (const at of points) {
    for (const hub of positioned) {
      const km = haversineKm(at.lat, at.lng, hub.lat as number, hub.lng as number);
      if (km <= hub.radiusKm * AREA_SLACK) return null;
      if (!nearest || km < nearest.km) nearest = { hub, km };
    }
  }
  return `${Math.round(nearest!.km)} km from ${nearest!.hub.name}, the nearest area`;
}

/** A host where every account is its own publisher, so the account is the site. */
const SHARED_HOSTS = new Set(['instagram.com', 'facebook.com']);

/** The site a listing came from: its host, or the account on a host that is everybody's. */
export function siteOf(url?: string): string {
  try {
    const { hostname, pathname } = new URL(url ?? '');
    const host = hostname.replace(/^(www|m)\./, '').toLowerCase();
    return SHARED_HOSTS.has(host) ? `${host}/${pathname.split('/')[1] ?? ''}`.toLowerCase() : host;
  } catch {
    return '';
  }
}

/**
 * Listing sites that carry everybody's events. One of these looks local when
 * the only pages of it that were read are the ones about an area, and it is
 * not: allevents.in's Bathurst page lists the Blue Mountains too.
 */
const AGGREGATORS = /(^|\.)(allevents\.in|eventbrite\.[a-z.]+|humanitix\.com|trybooking\.com|meetup\.com|ticketmaster\.[a-z.]+|eventfinda\.[a-z.]+)$/;

/** How many of a site's listings must be inside an area, and what share of the ones that are anywhere. */
const LOCAL_SITE_MIN = 3;
const LOCAL_SITE_SHARE = 0.8;

/**
 * The sites whose listings are nearly all inside an area.
 *
 * A council or a tourism board publishes for one town and often leaves the
 * town off the page; a national directory publishes for everywhere. Which is
 * which shows in the listings that can be placed, so nothing has to be kept
 * by hand. `elsewhere` is a listing known to be somewhere, and not in an area.
 */
export function localSites(events: { url?: string; area: string; elsewhere: boolean }[]): Set<string> {
  const tally = new Map<string, { inside: number; outside: number }>();
  for (const ev of events) {
    const site = siteOf(ev.url);
    if (!site || AGGREGATORS.test(site) || (!ev.area && !ev.elsewhere)) continue;
    const t = tally.get(site) ?? { inside: 0, outside: 0 };
    if (ev.area) t.inside++;
    else t.outside++;
    tally.set(site, t);
  }
  const out = new Set<string>();
  for (const [site, t] of tally) {
    if (t.inside >= LOCAL_SITE_MIN && t.inside / (t.inside + t.outside) >= LOCAL_SITE_SHARE) out.add(site);
  }
  return out;
}

/** Sources somebody pointed at their own area by hand, so a listing with no place is still theirs. */
const AREA_SCOPED_SOURCES = new Set(['ical']);

/**
 * Why an event nothing can put on the map is out of sight, or null when
 * something else says it is local.
 *
 * It used to be left alone, on the grounds that an unknown place is not a far
 * one. That held while the sources were local; a crawler that follows a
 * national directory brought in six hundred markets and overseas webinars
 * with no place at all, and every one was shown as though it were here. So an
 * unplaced event now has to bring some evidence:
 *
 *   - it came from a feed set up for this area;
 *   - its title names one of the areas;
 *   - its site's other listings are nearly all inside an area (see localSites
 *     in events.ts), which is how a tourism board's page with no address on
 *     it stays in.
 *
 * The last two are weak — a title is a page's own headline and a local site
 * has contact pages too — so when the model is checking listings, one let in
 * on them waits for its verdict however long that takes, rather than being
 * shown once the wait runs out.
 */
function unplacedReason(ev: Cullable, hubs: CullHub[]): string | null {
  if (ev.sources.some((s) => AREA_SCOPED_SOURCES.has(s.source))) return null;
  const named = hubs.some((h) => h.name.length >= 4 && new RegExp(`\\b${escapeRe(h.name)}\\b`, 'i').test(ev.title ?? ''));
  if (named || ev.localSite) return ev.unvetted ? 'Waiting to be checked' : null;
  return ev.unknownLocation ? 'No place given, so not known to be in any area' : 'Place not found, so not known to be in any area';
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How long a new event waits for the model before it is shown anyway, so a
 * model that is down or behind delays events rather than losing them.
 */
export const VET_WAIT_MS = 6 * 3600_000;

/**
 * Where a group stands with the vet job.
 *
 * One member the model called an event is enough: a merge of a real listing
 * with posts about it is an event. Turned down only when every member it read
 * was turned down. Pending while none has been read and the wait is not up.
 */
export function vetting(
  members: { llm_vet_note: string; llm_vetted_at: string; enrichment_failed?: boolean }[],
  firstSeenAt: string | null,
  on: boolean,
  now = Date.now()
): { notEvent: string; pending: boolean; shownAt: string | null; unvetted: boolean } {
  if (!on || !firstSeenAt) return { notEvent: '', pending: false, shownAt: firstSeenAt, unvetted: false };
  const read = members.filter((m) => m.llm_vetted_at || m.enrichment_failed);
  const yes = read.filter((m) => !m.llm_vet_note).map((m) => m.llm_vetted_at || firstSeenAt).sort()[0];
  const giveUp = new Date(Date.parse(firstSeenAt) + VET_WAIT_MS).toISOString();
  // Never before it was found, never after the wait ran out: an old event the
  // model gets round to today is not new today.
  const shownAt = [firstSeenAt, [yes ?? giveUp, giveUp].sort()[0]].sort()[1];
  return {
    notEvent: read.length > 0 && !yes ? read[0].llm_vet_note : '',
    pending: read.length === 0 && now < Date.parse(giveUp),
    shownAt,
    unvetted: !yes,
  };
}
