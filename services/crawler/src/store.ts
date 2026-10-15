import path from 'node:path';
import { PAST_GRACE_MS } from './shared/when.js';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureDataDir } from './config.js';
import { CrawledEvent } from './types.js';
import { normalizeUrl, siteOf } from './urls.js';
import { postTime, SocialLink, STALE_POST_DAYS } from './extract/social.js';
import { findKey } from './extract/jsonld.js';
import { tidyFind } from './tidy.js';
import {
  afterLeadingTo, afterRead, afterVerdict, dueAt, MAX_EVENTS_PER_READ, PageKind, pageKind, PRIOR_WEIGHT, PROFILE_START_YIELD, Standing, Verdict,
} from './revisit.js';

/**
 * The crawler's own memory, in its own file.
 *
 * Separate from the app's database on purpose. This one is churn — a
 * frontier of hundreds of thousands of URLs, rewritten constantly — and it has
 * no business sharing a file with the thing that holds a year of history and
 * gets backed up every night. Nothing here is precious: delete it and
 * the crawler rebuilds it from the seeds.
 *
 * The memory is also the point. event-scout's websearch pass re-searches from
 * nothing every cycle and throws away what it learned; a page that has yielded
 * an event before is the best guess about where the next one is, and that is
 * only usable if it is written down.
 */

const db = new DatabaseSync(path.join(ensureDataDir(), 'crawler.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  discovered_at TEXT NOT NULL,
  fetched_at TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pages_pick ON pages(state, score DESC);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site);

CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  found_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finds_start ON finds(start_time);

CREATE TABLE IF NOT EXISTS hosts (
  site TEXT PRIMARY KEY,
  robots TEXT NOT NULL DEFAULT '',
  robots_at TEXT,
  crawl_delay_ms INTEGER,
  last_fetch_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feeds (
  url TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  found_at TEXT NOT NULL,
  found_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seeds (
  url TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);
`);

/**
 * One row per finished cycle, for the graph on the crawler's page.
 *
 * The frontier says where the crawl is and nothing about how it got there;
 * whether the pages read are turning up events, or the queue is only growing,
 * is a question about the last day of cycles. Its own statement so databases
 * made before it pick it up.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS cycles (
  started_at TEXT PRIMARY KEY,
  finished_at TEXT NOT NULL,
  fetched INTEGER NOT NULL,
  events INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  seeded INTEGER NOT NULL,
  feeds INTEGER NOT NULL,
  queued INTEGER NOT NULL,
  finds INTEGER NOT NULL
);
`);

/**
 * Facebook events the crawl came across, for event-scout to read.
 *
 * Not in the frontier: the crawler never fetches them. event-scout has a
 * parser for Facebook's event pages and the crawler has no business carrying
 * a second one, so it only writes the link down.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS social (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  found_at TEXT NOT NULL,
  found_on TEXT NOT NULL
);
`);

/**
 * How many times each page has been read, for the crawler's page.
 *
 * Added after the table was, so an existing database gets it here. A duplicate
 * is success: two processes opening one file can both try.
 */
try {
  db.exec('ALTER TABLE pages ADD COLUMN reads INTEGER NOT NULL DEFAULT 0');
} catch (err) {
  if (!/duplicate column/i.test((err as Error).message)) throw err;
}

/**
 * What each page has been worth, for deciding when to read it again. See
 * revisit.ts. Added after the table was, so an existing database gets them here.
 *
 *   yield / empty_reads  the page's standing: see revisit.ts
 *   next_due             when it is next due; NULL means never again
 *   good / bad           the app's last verdict on the events found here
 *   verdict_at           when that verdict arrived
 *   parent               the page that linked to this one, so a post can
 *                        speak for the profile that led to it
 */
function addColumn(name: string, declaration: string): void {
  try {
    db.exec(`ALTER TABLE pages ADD COLUMN ${name} ${declaration}`);
  } catch (err) {
    if (!/duplicate column/i.test((err as Error).message)) throw err;
  }
}
addColumn('yield', 'REAL NOT NULL DEFAULT 0');
addColumn('empty_reads', 'INTEGER NOT NULL DEFAULT 0');
addColumn('next_due', 'TEXT');
addColumn('good', 'REAL NOT NULL DEFAULT 0');
addColumn('bad', 'REAL NOT NULL DEFAULT 0');
addColumn('verdict_at', 'TEXT');
addColumn('parent', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_pages_due ON pages(next_due)');

const now = (): string => new Date().toISOString();

// --- the frontier -----------------------------------------------------------

/**
 * Offer a URL to the frontier.
 *
 * Silent about duplicates, which is most of what it is asked: a site's every
 * page links to its front page. A URL already known keeps the shallower depth
 * and the better score, so arriving again by a worse route cannot demote it.
 */
export function offer(url: string, depth: number, score: number, parent?: string): boolean {
  const existing = db.prepare('SELECT depth, score FROM pages WHERE url = ?').get(url) as
    | { depth: number; score: number }
    | undefined;
  if (existing) {
    if (depth < existing.depth || score > existing.score) {
      db.prepare('UPDATE pages SET depth = MIN(depth, ?), score = MAX(score, ?) WHERE url = ?')
        .run(depth, score, url);
    }
    return false;
  }
  db.prepare(
    'INSERT INTO pages (url, site, depth, score, state, discovered_at, parent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(url, siteOf(url), depth, score, 'queued', now(), parent && parent !== url ? parent.slice(0, 500) : null);
  return true;
}

/**
 * The next pages worth fetching, best first and at most one per site.
 *
 * One per site is what makes politeness possible without a scheduler: the
 * caller fetches this batch in parallel knowing no two requests can land on the
 * same host, then comes back for more.
 */
export function nextBatch(size: number, excludeSites: string[] = []): { url: string; depth: number }[] {
  const skip = new Set(excludeSites);
  const rows = db
    .prepare(
      `SELECT url, site, depth FROM pages
        WHERE state = 'queued' AND depth <= ?
        ORDER BY score DESC, discovered_at ASC
        LIMIT ?`
    )
    .all(config.maxDepth, size * 20) as { url: string; site: string; depth: number }[];

  const out: { url: string; depth: number }[] = [];
  const used = new Set<string>();
  for (const row of rows) {
    if (skip.has(row.site) || used.has(row.site)) continue;
    used.add(row.site);
    out.push({ url: row.url, depth: row.depth });
    if (out.length >= size) break;
  }
  return out;
}

const isSeed = (url: string): boolean => db.prepare('SELECT 1 FROM seeds WHERE url = ?').get(url) !== undefined;

interface StandingRow {
  yield: number;
  empty_reads: number;
  reads: number;
  fetched_at: string | null;
  parent: string | null;
}

const standingOf = (url: string): StandingRow | undefined =>
  db.prepare('SELECT yield, empty_reads, reads, fetched_at, parent FROM pages WHERE url = ?').get(url) as
    | StandingRow
    | undefined;

/** Write a page's standing and work out when it is next due from when it was last read. */
function settle(url: string, kind: PageKind, s: Standing, lastReadMs: number): void {
  db.prepare('UPDATE pages SET yield = ?, empty_reads = ?, next_due = ? WHERE url = ?')
    .run(s.yield, s.emptyReads, dueAt(kind, s, lastReadMs), url);
}

/**
 * A page read. `fresh` is how many of its events the crawler had not kept
 * before, which is what decides whether the read was worth the trip: see
 * revisit.ts for how that sets the wait until the next one.
 */
export function markDone(url: string, events: number, note = '', fresh = events): void {
  const before = standingOf(url);
  db.prepare('UPDATE pages SET state = ?, fetched_at = ?, events = ?, note = ?, reads = reads + 1 WHERE url = ?')
    .run('done', now(), events, note, url);
  if (!before) return;
  const kind = pageKind(url, isSeed(url));
  let s: Standing = { yield: before.yield, emptyReads: before.empty_reads };
  if (before.reads === 0 && kind === 'profile' && s.yield === 0) s.yield = PROFILE_START_YIELD;
  s = afterRead(s, fresh);
  settle(url, kind, s, Date.now());
  // A post that holds an event is evidence for the account that led to it.
  if (kind === 'oneshot' && fresh > 0 && before.parent) creditParent(before.parent, (p) => afterLeadingTo(p, fresh));
}

/** Change a page's standing on the strength of something that happened to a page it led to. */
function creditParent(parentUrl: string, change: (s: Standing) => Standing): void {
  const row = standingOf(parentUrl);
  if (!row || !row.fetched_at) return;
  const kind = pageKind(parentUrl, isSeed(parentUrl));
  const s = change({ yield: row.yield, emptyReads: row.empty_reads });
  settle(parentUrl, kind, s, Date.parse(row.fetched_at));
}

export function markFailed(url: string, note: string, permanent = false): void {
  db.prepare('UPDATE pages SET state = ?, fetched_at = ?, note = ? WHERE url = ?')
    .run(permanent ? 'skipped' : 'failed', now(), note.slice(0, 200), url);
  if (permanent) {
    db.prepare('UPDATE pages SET next_due = NULL WHERE url = ?').run(url);
    return;
  }
  // A page that has delivered before, or an account, is worth trying again,
  // later each time it fails. One that never delivered anything stays failed.
  const row = standingOf(url);
  if (!row) return;
  const kind = pageKind(url, isSeed(url));
  if (row.reads === 0 && kind !== 'profile') return;
  settle(url, kind, afterRead({ yield: row.yield, emptyReads: row.empty_reads }, 0), Date.now());
}

/**
 * Put pages that are due back in the queue.
 *
 * A listing page is not finished when it has been read once: next week it has
 * different events on it. Which pages come back, and when, is set by what each
 * has been worth (revisit.ts): sites, Instagram accounts and Facebook Pages
 * alike. Pinned pages keep their own fixed cadence (requeueSeeds), and posts
 * are read once. At most `limit` a cycle, best first, so a backlog does not
 * crowd out everything new.
 */
export function requeueDue(limit: number): number {
  return db
    .prepare(
      `UPDATE pages SET state = 'queued'
        WHERE url IN (
          SELECT url FROM pages
           WHERE state IN ('done', 'failed') AND next_due IS NOT NULL AND next_due <= ?
             AND url NOT IN (SELECT url FROM seeds)
           ORDER BY yield DESC, next_due ASC LIMIT ?)`
    )
    .run(now(), limit).changes as number;
}

/**
 * Give pages read before yields existed the standing they would have had.
 *
 * Once. A page that produced events last time starts where a productive read
 * would have left it; an account gets the benefit of the doubt; the rest were
 * never revisited and are not now.
 */
function backfillRevisits(): void {
  if (getJson<string | null>('revisits-backfilled', null)) return;
  const rows = db
    .prepare(
      `SELECT url, events, fetched_at FROM pages
        WHERE next_due IS NULL AND fetched_at IS NOT NULL AND reads > 0 AND state IN ('done', 'failed')
          AND (events > 0 OR (site IN ('instagram.com', 'facebook.com') AND url NOT LIKE '%/p/%'))`
    )
    .all() as { url: string; events: number; fetched_at: string }[];
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const kind = pageKind(row.url, isSeed(row.url));
      if (kind === 'oneshot') continue;
      const start = kind === 'profile' && row.events === 0
        ? PROFILE_START_YIELD
        : PRIOR_WEIGHT * Math.min(row.events, MAX_EVENTS_PER_READ);
      settle(row.url, kind, { yield: start, emptyReads: 0 }, Date.parse(row.fetched_at));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  setJson('revisits-backfilled', now());
}

export function countPages(): Record<string, number> {
  const out: Record<string, number> = { queued: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of db.prepare('SELECT state, COUNT(*) n FROM pages GROUP BY state').all() as {
    state: string;
    n: number;
  }[]) {
    out[row.state] = row.n;
  }
  return out;
}

// --- what was found ---------------------------------------------------------

/** Keep a find, replacing any earlier reading of the same event. True when it was not held before. */
export function keep(event: CrawledEvent): boolean {
  const known = db.prepare('SELECT 1 FROM finds WHERE id = ?').get(event.sourceId) !== undefined;
  db.prepare('INSERT OR REPLACE INTO finds (id, start_time, found_at, payload) VALUES (?, ?, ?, ?)')
    .run(event.sourceId, event.startTime, event.foundAt, JSON.stringify(event));
  return !known;
}

/** Everything still ahead, newest find first. event-scout filters by area. */
export function finds(limit = 5000): CrawledEvent[] {
  const rows = db
    .prepare(
      `SELECT payload FROM finds WHERE start_time > ? ORDER BY found_at DESC LIMIT ?`
    )
    .all(new Date(Date.now() - PAST_GRACE_MS).toISOString(), limit) as { payload: string }[];
  const out: CrawledEvent[] = [];
  const now = new Date();
  for (const row of rows) {
    try {
      // Through the same tidy as a new find, so ones kept before it existed
      // arrive as tidy as the rest.
      const find = tidyFind(JSON.parse(row.payload) as CrawledEvent, now);
      if (find) out.push(find);
    } catch {
      // A row that will not parse is a row worth ignoring, not a crash.
    }
  }
  return out;
}

export function countFinds(): number {
  return (db.prepare('SELECT COUNT(*) n FROM finds').get() as { n: number }).n;
}

/** Drop events long past. Nothing here is a record worth keeping. */
export function tidyFinds(): number {
  const cutoff = new Date(Date.now() - config.keepFindsDays * 86400_000).toISOString();
  return db.prepare('DELETE FROM finds WHERE start_time < ?').run(cutoff).changes as number;
}

// --- hosts ------------------------------------------------------------------

export interface HostRow {
  site: string;
  robots: string;
  robots_at: string | null;
  crawl_delay_ms: number | null;
  last_fetch_at: string | null;
  failures: number;
}

export function host(site: string): HostRow | undefined {
  return db.prepare('SELECT * FROM hosts WHERE site = ?').get(site) as HostRow | undefined;
}

export function rememberRobots(site: string, body: string, crawlDelayMs: number | null): void {
  db.prepare(
    `INSERT INTO hosts (site, robots, robots_at, crawl_delay_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(site) DO UPDATE SET robots = excluded.robots, robots_at = excluded.robots_at,
       crawl_delay_ms = excluded.crawl_delay_ms`
  ).run(site, body, now(), crawlDelayMs);
}

export function touchHost(site: string, failed = false): void {
  db.prepare(
    `INSERT INTO hosts (site, last_fetch_at, failures) VALUES (?, ?, ?)
     ON CONFLICT(site) DO UPDATE SET last_fetch_at = excluded.last_fetch_at,
       failures = CASE WHEN ? THEN hosts.failures + 1 ELSE 0 END`
  ).run(site, now(), failed ? 1 : 0, failed ? 1 : 0);
}

/**
 * Sites fetched too recently to touch again.
 *
 * Politeness as a filter on what may be picked, rather than as a sleep inside
 * a worker: a worker that waits its turn is a worker doing nothing, and there
 * is always another site in the queue. `crawl_delay_ms` is the site's own
 * asking price where it named one, clamped by the caller.
 */
export function sitesOnCooldown(defaultDelayMs: number, maxDelayMs: number): string[] {
  const rows = db
    .prepare('SELECT site, last_fetch_at, crawl_delay_ms FROM hosts WHERE last_fetch_at IS NOT NULL')
    .all() as { site: string; last_fetch_at: string; crawl_delay_ms: number | null }[];
  const out: string[] = [];
  for (const row of rows) {
    const wait = Math.min(Math.max(row.crawl_delay_ms ?? 0, defaultDelayMs), maxDelayMs);
    if (Date.now() - Date.parse(row.last_fetch_at) < wait) out.push(row.site);
  }
  return out;
}

/** Feeds are handed to event-scout, which already reads iCal properly. */
export function rememberFeed(url: string, foundOn: string): void {
  db.prepare('INSERT OR IGNORE INTO feeds (url, site, found_at, found_on) VALUES (?, ?, ?, ?)')
    .run(url, siteOf(url), now(), foundOn);
}

export function feeds(): { url: string; site: string; foundOn: string }[] {
  return (
    db.prepare('SELECT url, site, found_on FROM feeds ORDER BY found_at DESC LIMIT 500').all() as {
      url: string;
      site: string;
      found_on: string;
    }[]
  ).map((r) => ({ url: r.url, site: r.site, foundOn: r.found_on }));
}

// --- what to look for -------------------------------------------------------

/** Pinned pages, and pages read on request, go to the front of the queue. */
export const PINNED_SCORE = 50;

export function getJson<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function listSeeds(): string[] {
  return (db.prepare('SELECT url FROM seeds ORDER BY added_at').all() as { url: string }[]).map((r) => r.url);
}

/**
 * Make the pinned pages exactly this list.
 *
 * Replace rather than add, so a page taken out of Settings stops being read.
 * A newly pinned one goes to the front of the queue at once, even if the crawl
 * had already been there: being asked for is a reason to look again.
 */
export function pinSeeds(urls: string[]): { added: number; removed: number } {
  const want = new Set(urls);
  const have = new Set(listSeeds());
  let added = 0;
  let removed = 0;
  for (const url of have) {
    if (want.has(url)) continue;
    db.prepare('DELETE FROM seeds WHERE url = ?').run(url);
    removed++;
  }
  for (const url of want) {
    if (have.has(url)) continue;
    db.prepare('INSERT OR IGNORE INTO seeds (url, added_at) VALUES (?, ?)').run(url, now());
    offer(url, 0, PINNED_SCORE);
    db.prepare("UPDATE pages SET state = 'queued', depth = 0, score = MAX(score, ?) WHERE url = ?")
      .run(PINNED_SCORE, url);
    added++;
  }
  return { added, removed };
}

/**
 * Put the pinned pages back at the front of the queue, once they are due.
 *
 * Every few hours rather than every cycle: a what's-on page changes weekly at
 * most, and reading it every half hour would be exactly the kind of attention
 * robots.txt exists to discourage.
 */
export function requeueSeeds(olderThanHours: number): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  let n = 0;
  for (const url of listSeeds()) {
    if (offer(url, 0, PINNED_SCORE)) {
      n++;
      continue;
    }
    n += db
      .prepare(
        `UPDATE pages SET state = 'queued', depth = 0, score = MAX(score, ?)
          WHERE url = ? AND state != 'queued' AND (fetched_at IS NULL OR fetched_at < ?)`
      )
      .run(PINNED_SCORE, url, cutoff).changes as number;
  }
  return n;
}

// --- history ----------------------------------------------------------------

/** A finished cycle, with the queue and the finds as they stood at its end. */
export interface CycleRow {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  events: number;
  failed: number;
  blocked: number;
  seeded: number;
  feeds: number;
  /** Pages waiting when it finished. */
  queued: number;
  /** Events held when it finished. */
  finds: number;
}

/** Cycles kept. At the default half-hour interval, about four days. */
const KEEP_CYCLES = 200;

export function recordCycle(
  r: Pick<CycleRow, 'startedAt' | 'fetched' | 'events' | 'failed' | 'blocked' | 'seeded' | 'feeds'> & {
    finishedAt: string | null;
  }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO cycles
       (started_at, finished_at, fetched, events, failed, blocked, seeded, feeds, queued, finds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    r.startedAt, r.finishedAt ?? now(), r.fetched, r.events, r.failed, r.blocked, r.seeded, r.feeds,
    countPages().queued ?? 0, countFinds()
  );
  db.prepare(
    'DELETE FROM cycles WHERE started_at NOT IN (SELECT started_at FROM cycles ORDER BY started_at DESC LIMIT ?)'
  ).run(KEEP_CYCLES);
}

/** The most recent cycles, oldest first, which is the order a graph reads in. */
export function cycleHistory(limit = 48): CycleRow[] {
  const rows = db
    .prepare(
      `SELECT started_at, finished_at, fetched, events, failed, blocked, seeded, feeds, queued, finds
         FROM cycles ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, string | number>[];
  return rows.reverse().map((r) => ({
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at),
    fetched: Number(r.fetched),
    events: Number(r.events),
    failed: Number(r.failed),
    blocked: Number(r.blocked),
    seeded: Number(r.seeded),
    feeds: Number(r.feeds),
    queued: Number(r.queued),
    finds: Number(r.finds),
  }));
}

// --- instagram and facebook -------------------------------------------------

/** Where a post and a profile go in the queue: posts first, since they are what hold events. */
const SOCIAL_POST_SCORE = 15;
const SOCIAL_PROFILE_SCORE = 8;

/**
 * Offer an Instagram or Facebook link.
 *
 * Instagram goes into the frontier at depth 0 — it is off-site from wherever
 * it was linked, and the depth cap is about a site's own links. Facebook
 * events are only written down, for event-scout. True when it was new.
 */
export function offerSocial(link: SocialLink, foundOn: string): boolean {
  if (link.kind === 'facebook-event') {
    return (
      (db
        .prepare('INSERT OR IGNORE INTO social (url, kind, ref, found_at, found_on) VALUES (?, ?, ?, ?, ?)')
        .run(link.url, link.kind, link.id, now(), foundOn.slice(0, 500)).changes as number) > 0
    );
  }
  // A post's shortcode says when it was made, so one from two years ago is
  // passed over without a request: profiles and searches turn up plenty.
  if (link.kind === 'instagram-post') {
    const at = postTime(link.id);
    if (at && Date.now() - at.getTime() > STALE_POST_DAYS * 86400_000) return false;
  }
  return offer(link.url, 0, link.kind === 'instagram-post' ? SOCIAL_POST_SCORE : SOCIAL_PROFILE_SCORE, foundOn);
}

export function socialLinks(kind: string, limit = 300): { url: string; id: string; foundOn: string; foundAt: string }[] {
  return (
    db
      .prepare('SELECT url, ref, found_on, found_at FROM social WHERE kind = ? ORDER BY found_at DESC LIMIT ?')
      .all(kind, limit) as { url: string; ref: string; found_on: string; found_at: string }[]
  ).map((r) => ({ url: r.url, id: r.ref, foundOn: r.found_on, foundAt: r.found_at }));
}

export function countSocial(): {
  instagramProfiles: number;
  instagramPostsRead: number;
  instagramEvents: number;
  facebookEvents: number;
} {
  const ig = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' THEN 0 ELSE 1 END), 0) AS profiles,
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' AND state = 'done' THEN 1 ELSE 0 END), 0) AS posts,
         COALESCE(SUM(CASE WHEN url LIKE '%/p/%' THEN events ELSE 0 END), 0) AS events
       FROM pages WHERE site = 'instagram.com'`
    )
    .get() as { profiles: number; posts: number; events: number };
  const fb = db.prepare("SELECT COUNT(*) n FROM social WHERE kind = 'facebook-event'").get() as { n: number };
  return {
    instagramProfiles: Number(ig.profiles),
    instagramPostsRead: Number(ig.posts),
    instagramEvents: Number(ig.events),
    facebookEvents: Number(fb.n),
  };
}

/** Hold a site to a gap of its own, whatever robots.txt did or did not ask for. */
export function setHostDelay(site: string, ms: number): void {
  db.prepare(
    `INSERT INTO hosts (site, crawl_delay_ms) VALUES (?, ?)
     ON CONFLICT(site) DO UPDATE SET crawl_delay_ms = excluded.crawl_delay_ms`
  ).run(site, ms);
}

// --- pages, for the crawler's page ------------------------------------------

export interface PageRow {
  url: string;
  site: string;
  state: string;
  /** Times it has been read successfully. */
  reads: number;
  /** Events on it the last time it was read. */
  events: number;
  fetchedAt: string | null;
  note: string;
  /** What it has been worth: a decaying average of good events per read. See revisit.ts. */
  yield: number;
  /** When it is next due; null when it is never read again (a post, or a page given up on). */
  nextDue: string | null;
  /** Reads in a row that found nothing new. */
  emptyReads: number;
  /** The app's last verdict on the events found here: shown, and culled or hidden. */
  good: number;
  bad: number;
}

/** How many times one page has been read. 0 for one it has never read or never heard of. */
export function readsOf(url: string): number {
  const row = db.prepare('SELECT reads FROM pages WHERE url = ?').get(url) as { reads: number } | undefined;
  return row ? Number(row.reads) : 0;
}

const PAGE_COLUMNS = 'url, site, state, reads, events, fetched_at, note, yield, next_due, empty_reads, good, bad';

/** The pages read most often, most recently, or with the best yield. */
export function pageList(sort: 'reads' | 'recent' | 'yield', limit = 50): PageRow[] {
  const rows = db
    .prepare(
      sort === 'reads'
        ? `SELECT ${PAGE_COLUMNS} FROM pages
            WHERE reads > 0 ORDER BY reads DESC, fetched_at DESC LIMIT ?`
        : sort === 'yield'
          ? `SELECT ${PAGE_COLUMNS} FROM pages
              WHERE reads > 0 ORDER BY yield DESC, fetched_at DESC LIMIT ?`
          : `SELECT ${PAGE_COLUMNS} FROM pages
              WHERE fetched_at IS NOT NULL ORDER BY fetched_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    url: String(r.url),
    site: String(r.site),
    state: String(r.state),
    reads: Number(r.reads),
    events: Number(r.events),
    fetchedAt: r.fetched_at == null ? null : String(r.fetched_at),
    note: String(r.note ?? ''),
    yield: Math.round(Number(r.yield) * 100) / 100,
    nextDue: r.next_due == null ? null : String(r.next_due),
    emptyReads: Number(r.empty_reads),
    good: Number(r.good),
    bad: Number(r.bad),
  }));
}

// --- the app's verdicts -----------------------------------------------------

/** A verdict older than this no longer counts as the last word: its events have long since passed. */
const VERDICT_STALE_MS = 45 * 86400_000;

interface VerdictRow {
  good: number;
  bad: number;
  verdict_at: string | null;
  yield: number;
  empty_reads: number;
  fetched_at: string | null;
  parent: string | null;
}

/**
 * Take the app's word on which finds were any good.
 *
 * The app sends current totals per page, not changes, and sends them again
 * after every refresh; what moves a page's yield is only what is new since
 * the last verdict (revisit.ts), so repeating one does nothing. A post speaks
 * for the account that led to it as well as for itself. Returns how many
 * verdicts named a page the crawler knows.
 */
export function applyVerdicts(list: Verdict[]): number {
  let known = 0;
  for (const v of list) {
    // As the frontier spells it: social links keep a trailing slash that normalizeUrl drops.
    const normal = normalizeUrl(v.foundOn) ?? v.foundOn;
    let url = v.foundOn;
    let row: VerdictRow | undefined;
    for (const candidate of [v.foundOn, normal, `${normal}/`]) {
      row = db
        .prepare('SELECT good, bad, verdict_at, yield, empty_reads, fetched_at, parent FROM pages WHERE url = ?')
        .get(candidate) as VerdictRow | undefined;
      if (row) {
        url = candidate;
        break;
      }
    }
    if (!row) continue;
    known++;
    const good = Math.max(0, Number(v.good) || 0);
    const bad = Math.max(0, Number(v.bad) || 0);
    const stale = !row.verdict_at || Date.now() - Date.parse(row.verdict_at) > VERDICT_STALE_MS;
    const newGood = Math.max(0, good - (stale ? 0 : row.good));
    const newBad = Math.max(0, bad - (stale ? 0 : row.bad));
    db.prepare('UPDATE pages SET good = ?, bad = ?, verdict_at = ? WHERE url = ?').run(good, bad, now(), url);
    if (newGood === 0 && newBad === 0) continue;

    const kind = pageKind(url, isSeed(url));
    if (row.fetched_at) {
      settle(url, kind, afterVerdict({ yield: row.yield, emptyReads: row.empty_reads }, newGood, newBad), Date.parse(row.fetched_at));
    }
    if (kind === 'oneshot' && row.parent) creditParent(row.parent, (p) => afterVerdict(p, newGood, newBad));
  }
  return known;
}

/**
 * The town a post used to be given out of its caption, taken back off posts
 * kept before that stopped. See eventFromPost. Matches nothing once they have
 * all been cleared, so it is left to run.
 */
db.exec("UPDATE finds SET payload = json_remove(payload, '$.address') WHERE id LIKE 'instagram:%' AND json_extract(payload, '$.address') IS NOT NULL");

backfillRevisits();
