/**
 * Site boilerplate: the same blurb a scraper keeps finding in place of a
 * description.
 *
 * Some sites serve one generic meta description for every page, and a scraper
 * that falls back to it stores the title with that blurb after it — "All
 * Commodore Night 2026: Find the best Automotive Social Platform And Directory
 * now…". A model shown that answers about the directory rather than the event,
 * and hides a real listing as "not an event". The text says nothing about the
 * listing it is attached to, so the model is better off with nothing.
 *
 * Found rather than listed: the same text, once the title is taken off the
 * front, under three or more listings of one host is not a description of any
 * of them. Two could be a coincidence (a venue reposting its own text); three
 * is a pattern. Its own module because none of it touches a database, for the
 * reason given at the head of merge.ts.
 */

/** Shortest text that can be boilerplate: shorter ones ("Free entry") repeat honestly. */
const MIN_LENGTH = 40;

/** Rows of one host that must share a text before it counts. */
const MIN_ROWS = 3;

/** The columns this needs from a listing. */
export interface BoilerplateRow {
  url: string;
  title: string;
  description: string | null;
}

/** The host a listing was found on, without a leading "www.", or '' where the url is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A description as boilerplate would repeat it: the row's own title and its
 * separator off the front, whitespace collapsed, lowercased.
 */
export function normalizeDescription(title: string, description: string | null): string {
  let text = (description ?? '').replace(/\s+/g, ' ').trim();
  const name = title.replace(/\s+/g, ' ').trim();
  if (name && text.toLowerCase().startsWith(name.toLowerCase())) {
    text = text.slice(name.length).replace(/^\s*[:\-|–—]\s*/, '');
  }
  return text.trim().toLowerCase();
}

const keyOf = (host: string, text: string): string => `${host}\n${text}`;

/**
 * The boilerplate across a set of listings, as `${host}\n${normalized text}`.
 *
 * Exact match only, after normalization. A description that merely begins with
 * the blurb and carries more after it is kept: that more may be the event.
 */
export function findBoilerplate(rows: readonly BoilerplateRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const host = hostOf(row.url);
    const text = normalizeDescription(row.title, row.description);
    if (!host || text.length < MIN_LENGTH) continue;
    const key = keyOf(host, text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const found = new Set<string>();
  for (const [key, n] of counts) if (n >= MIN_ROWS) found.add(key);
  return found;
}

export function isBoilerplate(found: ReadonlySet<string>, row: BoilerplateRow): boolean {
  if (found.size === 0) return false;
  const host = hostOf(row.url);
  return host !== '' && found.has(keyOf(host, normalizeDescription(row.title, row.description)));
}

/** The description to show a model: the listing's own, or '' where it is the site's. */
export function cleanDescription(found: ReadonlySet<string>, row: BoilerplateRow): string {
  return isBoilerplate(found, row) ? '' : (row.description ?? '');
}
