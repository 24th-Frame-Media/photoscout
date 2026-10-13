/**
 * When to look at a page again.
 *
 * A page that turns up good events is worth coming back to; one that does not
 * is worth coming back to less and less, and eventually not at all. Everything
 * here is arithmetic on two numbers per page, so it can be tested without a
 * database or a clock:
 *
 *   yield        a decaying average of good events per read. Rises on a read
 *                that finds new events (a weak guess, from the crawler's own
 *                extraction) and again when the app says they were good.
 *   emptyReads   consecutive reads that found nothing new. Reset by any new
 *                event, or by the app calling one good.
 *
 * The wait before the next read is a base set by the yield, doubled for every
 * empty read, up to a cap. A page that has gone quiet for long enough at the
 * cap, and was never much to begin with, is dropped from revisits.
 */

/** How much one read moves the average. */
export const ALPHA = 0.35;
/** What one freshly extracted event is worth before the app has judged it. */
export const PRIOR_WEIGHT = 0.3;
/** Events counted from a single read, so one huge calendar cannot stand for a productive page. */
export const MAX_EVENTS_PER_READ = 5;

export const HOUR_MS = 3600_000;
/** The longest a page is left alone. */
export const MAX_INTERVAL_HOURS = 30 * 24;
/** Pinned pages keep the cadence they always had. */
export const SEED_INTERVAL_HOURS = 6;
/** Below this a page has never been worth anything. */
export const NEGLIGIBLE_YIELD = 0.05;
/** Where an account starts: it holds no events itself, its posts do, so it gets some benefit of the doubt. */
export const PROFILE_START_YIELD = 0.5;

/**
 * Hours between reads of a page at a given yield, before any empty reads.
 * Productive pages come round every 6 to 12 hours; poor ones, daily or two-daily.
 */
export function baseHours(yieldValue: number): number {
  if (yieldValue >= 2) return 6;
  if (yieldValue >= 1) return 9;
  if (yieldValue >= 0.4) return 12;
  if (yieldValue >= 0.1) return 24;
  return 48;
}

/** The wait after `emptyReads` reads in a row that found nothing new. Doubles each time, capped. */
export function intervalHours(yieldValue: number, emptyReads: number): number {
  const doubled = baseHours(yieldValue) * 2 ** Math.min(Math.max(0, emptyReads), 12);
  return Math.min(MAX_INTERVAL_HOURS, doubled);
}

/**
 * What a URL is, for deciding how it is revisited.
 *
 *   seed     a pinned page: fixed cadence, never dropped
 *   oneshot  a single Instagram post: a caption does not change, so it is read once
 *   profile  an Instagram or Facebook account: holds no events itself, its posts and events do
 *   page     anything else
 */
export type PageKind = 'seed' | 'oneshot' | 'profile' | 'page';

export function pageKind(url: string, isSeed: boolean): PageKind {
  if (isSeed) return 'seed';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'page';
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|web|business)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'instagram.com') {
    return parts.includes('p') || parts.includes('reel') ? 'oneshot' : 'profile';
  }
  if (host === 'facebook.com') {
    return parts.includes('events') && /^\d+$/.test(parts[parts.indexOf('events') + 1] ?? '') ? 'oneshot' : 'profile';
  }
  return 'page';
}

export interface Standing {
  yield: number;
  emptyReads: number;
}

/**
 * After a read. `fresh` is how many events it found that the crawler had not
 * kept before: re-reading a calendar and finding the same ten events is a read
 * that found nothing.
 */
export function afterRead(s: Standing, fresh: number): Standing {
  const sample = PRIOR_WEIGHT * Math.min(Math.max(0, fresh), MAX_EVENTS_PER_READ);
  return {
    yield: (1 - ALPHA) * s.yield + ALPHA * sample,
    emptyReads: fresh > 0 ? 0 : s.emptyReads + 1,
  };
}

/**
 * After the app judged some of this page's events: `good` more are shown (the
 * server weights one with a flyer higher), `bad` more were culled or hidden.
 * Both are changes since the last verdict, so a verdict sent twice counts once.
 *
 * A bad one takes back what the crawler's own guess gave it; a good one adds
 * on top of that guess, which is why the guess can stay weak.
 */
export function afterVerdict(s: Standing, newGood: number, newBad: number): Standing {
  const credit = ALPHA * (Math.max(0, newGood) - PRIOR_WEIGHT * Math.max(0, newBad));
  return {
    yield: Math.max(0, s.yield + credit),
    // Good news brings a page back to its base cadence; bad news changes nothing but the yield.
    emptyReads: newGood > 0 ? 0 : s.emptyReads,
  };
}

export interface Plan {
  /** Hours until it is due again; null when it is never revisited. */
  hours: number | null;
}

/**
 * When a page is next due, and whether it is dropped.
 *
 * A page that has never been worth anything is dropped at its first empty read
 * (as the crawler has always done); an account is given the cap's worth of
 * chances first, since its own reads never hold events and the proof arrives
 * later through its posts.
 */
export function plan(kind: PageKind, s: Standing): Plan {
  if (kind === 'oneshot') return { hours: null };
  if (kind === 'seed') return { hours: SEED_INTERVAL_HOURS };
  if (kind === 'page' && s.emptyReads > 0 && s.yield < NEGLIGIBLE_YIELD) return { hours: null };
  const hours = intervalHours(s.yield, s.emptyReads);
  if (hours >= MAX_INTERVAL_HOURS && s.yield < NEGLIGIBLE_YIELD) return { hours: null };
  return { hours };
}

/** The ISO time a page is next due, given when it was last read; null when it never is. */
export function dueAt(kind: PageKind, s: Standing, lastReadMs: number): string | null {
  const { hours } = plan(kind, s);
  return hours === null ? null : new Date(lastReadMs + hours * HOUR_MS).toISOString();
}

/** What the app made of the events found on one page. */
export interface Verdict {
  foundOn: string;
  /** Events now shown, a flyer's counting for more than one without. */
  good: number;
  /** Events culled, hidden or never placed. */
  bad: number;
}

/** Verdicts from a POST /verdicts body, malformed entries dropped. */
export function parseVerdicts(value: unknown): Verdict[] {
  if (!Array.isArray(value)) return [];
  const out: Verdict[] = [];
  for (const item of value.slice(0, 20000)) {
    if (!item || typeof item !== 'object') continue;
    const { foundOn, good, bad } = item as { foundOn?: unknown; good?: unknown; bad?: unknown };
    if (typeof foundOn !== 'string' || !foundOn) continue;
    const g = Number(good ?? 0);
    const b = Number(bad ?? 0);
    if (!Number.isFinite(g) || !Number.isFinite(b)) continue;
    out.push({ foundOn: foundOn.slice(0, 600), good: Math.min(g, 1000), bad: Math.min(b, 1000) });
  }
  return out;
}

/**
 * An account's post turned up `fresh` new events. The account was not read
 * again for this, so it adds to the account rather than averaging with it.
 */
export function afterLeadingTo(s: Standing, fresh: number): Standing {
  const sample = PRIOR_WEIGHT * Math.min(Math.max(0, fresh), MAX_EVENTS_PER_READ);
  return { yield: s.yield + ALPHA * sample, emptyReads: fresh > 0 ? 0 : s.emptyReads };
}
