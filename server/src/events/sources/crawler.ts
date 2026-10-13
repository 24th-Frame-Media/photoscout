import { db } from '../db.js';
import { bumpEventsVersion, getMergedEvents, MergedEvent } from '../events.js';
import { fetchFb, parseEvent } from './facebook.js';
import { expandTopics, rotateQueries } from './topics.js';
import { EventSourceAdapter, Location, MissingConfigError, RawEvent, Settings } from './types.js';
import { ollamaUrl } from '../enrich/pipeline.js';

/**
 * Events from the crawler, which is a separate program.
 *
 * It runs beside this one, keeps its own database and its own frontier, and is
 * asked rather than listened to: this adapter fetches what it has found when a
 * refresh comes round, and everything after that — validation, geocoding,
 * dedupe, archiving, the model passes — happens exactly as it does for any
 * other source. So a crawler that returns nonsense is a switch in Settings and
 * nothing worse, and it never holds a credential for this app or writes a row.
 *
 * What it should look for is handed over separately, by syncCrawler below, so
 * Settings stays the one place any of it is decided.
 */

const TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 8000;

/** What the crawler sends. Its own shape, close to but not the same as ours. */
interface CrawledEvent {
  sourceId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime?: string;
  venueName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  url?: string;
  imageUrl?: string;
  priceText?: string;
  isOnline?: boolean;
  dateOnly?: boolean;
  /** The page it was found on: what a verdict on it is sent back against. */
  foundOn?: string;
}

/** Where the crawler listens: Settings, then CRAWLER_URL, then nowhere. */
export function crawlerBase(settings: Settings): string {
  const url = (settings.crawlerUrl ?? '').trim() || process.env.CRAWLER_URL || '';
  return url.replace(/\/+$/, '');
}

export interface CrawlerConfig {
  /** Each area, with the bare terms to search for in it. */
  interests: { city: string; terms: string[] }[];
  /** Pages to read every few hours, whatever the searches find. */
  seeds: string[];
  ollamaUrl?: string;
  llmModel?: string;
}

/**
 * What the crawler should look for, from Settings.
 *
 * The same topics and extra terms web search expands, in every area, so
 * switching a topic on changes what both go looking for. Before this only the
 * extra terms were passed — empty, in the usual case — and the crawler fell
 * back on a generic list of its own, ignoring every topic that had been chosen.
 *
 * Pure, so what the crawler is told can be tested without one.
 */
export function crawlerConfigFrom(settings: Settings): CrawlerConfig {
  const extra = (settings.webSearchTerms ?? []).map((t) => t.trim()).filter(Boolean);
  const interests: CrawlerConfig['interests'] = [];
  const seen = new Set<string>();
  for (const raw of [settings.city, ...(settings.eventAreas ?? []).map((a) => a.name)]) {
    const city = (raw ?? '').trim();
    if (!city || seen.has(city.toLowerCase())) continue;
    seen.add(city.toLowerCase());
    // The format ignores the place: the crawler appends whichever area it is
    // searching, so a term goes over bare.
    const topics = expandTopics(settings.eventTopics ?? [], city, (term) => term);
    interests.push({ city, terms: [...new Set([...topics, ...extra])] });
  }
  const seeds = [
    ...new Set((settings.crawlerUrls ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u))),
  ];
  return {
    interests,
    seeds,
    ollamaUrl: settings.llmEnabled ? ollamaUrl(settings.llmUrl) : undefined,
    llmModel: settings.llmModel,
  };
}

/**
 * Tell the crawler what to look for.
 *
 * Called when settings are saved, at startup, and before every fetch, so a
 * change reaches it on its next cycle rather than at the next refresh, which
 * can be six hours away. With the source switched off it is sent nothing to
 * do, which puts it to rest — otherwise switching the source off would only
 * stop this app listening while the crawler carried on regardless.
 *
 * Never throws. A crawler that is down must not make saving settings fail.
 */
export async function syncCrawler(settings: Settings): Promise<{ ok: boolean; message: string }> {
  const base = crawlerBase(settings);
  if (!base) return { ok: false, message: 'no crawler address' };
  const off = settings.enabledSources?.crawler === false;
  const config = crawlerConfigFrom(settings);
  const body: CrawlerConfig = {
    interests: off ? [] : config.interests,
    seeds: off ? [] : config.seeds,
    ollamaUrl: settings.llmEnabled ? ollamaUrl(settings.llmUrl) : undefined,
    llmModel: settings.llmModel,
  };
  try {
    const res = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, message: off ? 'told to rest' : 'told what to look for' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Facebook event pages read per refresh, rotating through the rest. */
const FB_PER_REFRESH = 25;
const FB_DELAY_MS = 500;
/** A refresh asks once per area; an event read for the first is not read again for the next. */
const FB_REUSE_MS = 30 * 60 * 1000;
const fbRead = new Map<string, { at: number; event: RawEvent | null }>();

/**
 * Facebook events the crawl came across, read here.
 *
 * The crawler notes the links and nothing more: reading a Facebook event page
 * takes a parser for Facebook's embedded format, and this app already has one,
 * so the reading happens where the parser is. No cookie is needed for an event
 * page — the one set for the Facebook source is sent if there is one.
 */
async function facebookFromCrawler(base: string, loc: Location, settings: Settings): Promise<RawEvent[]> {
  let links: { id: string; foundOn?: string }[] = [];
  try {
    const res = await fetch(`${base}/social?kind=facebook-event`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    links = ((await res.json()) as { links?: { id: string; foundOn?: string }[] }).links ?? [];
  } catch {
    return [];
  }

  const foundOnOf = new Map(links.map((l) => [l.id, l.foundOn ?? '']));
  const out: RawEvent[] = [];
  for (const id of rotateQueries(links.map((l) => l.id).filter((id) => /^\d+$/.test(id)), FB_PER_REFRESH)) {
    let seen = fbRead.get(id);
    if (!seen || Date.now() - seen.at > FB_REUSE_MS) {
      let event: RawEvent | null = null;
      try {
        event = parseEvent(await fetchFb(`https://www.facebook.com/events/${id}`, (settings.fbCookie ?? '').trim()), id);
      } catch {
        // Private, deleted, or behind a login wall: expected, and not worth a failure.
      }
      seen = { at: Date.now(), event };
      fbRead.set(id, seen);
      await new Promise((r) => setTimeout(r, FB_DELAY_MS));
    }
    const ev = seen.event;
    if (!ev) continue;
    out.push({ ...ev, sourceId: `crawl:fb:${id}` });
    rememberFoundOn(`crawl:fb:${id}`, foundOnOf.get(id));
  }
  return out;
}

export const crawlerSource: EventSourceAdapter = {
  name: 'crawler',
  label: 'Web crawler',
  unofficial: true,

  async fetchEvents(loc: Location, settings: Settings): Promise<RawEvent[]> {
    const base = crawlerBase(settings);
    if (!base) {
      throw new MissingConfigError(
        'No crawler address. Run the crawler container and set its URL in Settings.'
      );
    }
    // Kept current on every refresh as well as on save, in case the crawler
    // was down, or started over with an empty database, when settings changed.
    await syncCrawler(settings);

    const query = new URLSearchParams({
      lat: String(loc.lat),
      lng: String(loc.lng),
      radiusKm: String(loc.radiusKm),
    });

    let res: Response;
    try {
      res = await fetch(`${base}/events?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'no answer' : (err as Error).message;
      throw new Error(`Cannot reach the crawler at ${base}: ${reason}`);
    }
    if (!res.ok) throw new Error(`The crawler answered HTTP ${res.status}`);

    const body = (await res.json()) as { events?: CrawledEvent[] };
    const events = Array.isArray(body.events) ? body.events : [];

    const crawled = events
      .filter((e) => e && typeof e.title === 'string' && typeof e.startTime === 'string')
      .map((e): RawEvent => {
        rememberFoundOn(`crawl:${e.sourceId}`.slice(0, 400), e.foundOn);
        return {
          // Prefixed so a crawled listing can never collide with one scraped
          // directly, and so it is obvious in the database where a row came from.
          sourceId: `crawl:${e.sourceId}`.slice(0, 400),
          title: e.title,
          description: e.description,
          startTime: e.startTime,
          endTime: e.endTime,
          venueName: e.venueName,
          address: e.address,
          lat: e.lat,
          lng: e.lng,
          url: e.url,
          imageUrl: e.imageUrl,
          priceText: e.priceText,
          isOnline: e.isOnline,
          dateOnly: e.dateOnly === true,
        };
      });
    return [...crawled, ...(await facebookFromCrawler(base, loc, settings))];
  },
};

// --- verdicts ---------------------------------------------------------------

/**
 * The page each find came from, kept from the fetch until the verdicts are
 * sent after the refresh. A find that the validation pass drops or the cull
 * hides leaves no trace of where it came from, so it is remembered here.
 */
const provenance = new Map<string, string>();

function rememberFoundOn(sourceId: string, foundOn: string | undefined): void {
  if (foundOn) provenance.set(sourceId, foundOn);
}

/** What became of one find. */
export interface Outcome {
  /** Shown, or not (culled, hidden, or never stored); or not yet decidable. */
  state: 'shown' | 'bad' | 'undecided';
  /** Filed under one of the searched areas. */
  inArea: boolean;
  /** It has a flyer or image. */
  hasImage: boolean;
}

/** A shown find, a flyer's counting for more, and one filed under no area for less. */
export const GOOD_WEIGHT = 1;
export const FLYER_BONUS = 0.5;
export const UNPLACED_FACTOR = 0.5;

export interface CrawlerVerdict {
  foundOn: string;
  good: number;
  bad: number;
}

/** The outcome of a merged event the crawler contributed to. */
export function outcomeOfEvent(ev: Pick<MergedEvent, 'culled' | 'hidden' | 'area' | 'images'>): Outcome {
  const hasImage = ev.images.length > 0;
  const inArea = ev.area !== '';
  // The model has not read it yet: it will be judged on a later refresh.
  if (ev.culled && /^Waiting to be checked/i.test(ev.culled)) return { state: 'undecided', inArea, hasImage };
  if (ev.hidden || ev.culled) return { state: 'bad', inArea, hasImage };
  return { state: 'shown', inArea, hasImage };
}

/**
 * Add up the outcomes per page. A null outcome is a find that never made it
 * into the database (rejected on date, or outside every area) and counts bad.
 */
export function tallyVerdicts(entries: { foundOn: string; outcome: Outcome | null }[]): CrawlerVerdict[] {
  const by = new Map<string, CrawlerVerdict>();
  for (const { foundOn, outcome } of entries) {
    if (outcome?.state === 'undecided') continue;
    const v = by.get(foundOn) ?? { foundOn, good: 0, bad: 0 };
    if (outcome?.state === 'shown') {
      v.good += (GOOD_WEIGHT + (outcome.hasImage ? FLYER_BONUS : 0)) * (outcome.inArea ? 1 : UNPLACED_FACTOR);
    } else {
      v.bad += 1;
    }
    by.set(foundOn, v);
  }
  return [...by.values()].map((v) => ({ ...v, good: Math.round(v.good * 100) / 100 }));
}

/**
 * Tell the crawler which of its finds were any good.
 *
 * Called at the end of a refresh, once everything has been validated, placed
 * and culled: a find is good when it survived all that and is shown, and bad
 * when it was dropped, culled or hidden. The crawler turns that into how often
 * to come back to the page each came from. Totals per page, not changes; the
 * crawler works out what is new. Never throws: a crawler that is down must
 * not fail a refresh. Returns a line for the refresh log, or null when there
 * was nothing to say.
 */
export async function sendCrawlerVerdicts(settings: Settings): Promise<string | null> {
  const base = crawlerBase(settings);
  const heard = new Map(provenance);
  provenance.clear();
  if (!base || heard.size === 0 || settings.enabledSources?.crawler === false) return null;
  try {
    const stored = new Map(
      (db.prepare("SELECT id, source_id FROM events WHERE source = 'crawler'").all() as unknown as { id: number; source_id: string }[])
        .map((r) => [r.source_id, r.id])
    );
    // A fresh merge: rows were written during the refresh.
    bumpEventsVersion();
    const byMember = new Map<number, MergedEvent>();
    for (const ev of getMergedEvents()) for (const m of ev.members) byMember.set(m.id, ev);

    const entries: { foundOn: string; outcome: Outcome | null }[] = [];
    for (const [sourceId, foundOn] of heard) {
      const id = stored.get(sourceId);
      if (id === undefined) {
        entries.push({ foundOn, outcome: null });
        continue;
      }
      const ev = byMember.get(id);
      // Not in the list: it has been and gone, which says nothing about the page.
      if (ev) entries.push({ foundOn, outcome: outcomeOfEvent(ev) });
    }
    const verdicts = tallyVerdicts(entries);
    if (verdicts.length === 0) return null;

    const res = await fetch(`${base}/verdicts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdicts }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS * 2),
    });
    if (!res.ok) return `Crawler verdicts: HTTP ${res.status}`;
    const good = verdicts.reduce((n, v) => n + (v.good > 0 ? 1 : 0), 0);
    return `Crawler: told it how ${verdicts.length} page${verdicts.length === 1 ? '' : 's'} did (${good} with events kept)`;
  } catch (err) {
    return `Crawler verdicts failed: ${(err as Error).message}`;
  }
}
