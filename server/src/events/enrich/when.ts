import { whenFromText } from '../shared/textWhen.js';
import { FUTURE_HORIZON_MS, MAX_DURATION_MS, parseWhen } from '../shared/when.js';

/**
 * What of the date check is believed.
 *
 * The model is asked to quote the words of the listing that state the date, and
 * to say whether they agree with the date shown. Nothing it says about a date
 * is taken on its word: a correction changes what a reader sees as the start,
 * and a plausible wrong hour is worse than none, so every one has to be
 * backed by a quotation that is really in the listing and that the app's own
 * date reader, which knows nothing of the model's answer, reads the same way.
 * A correction that fails any test is dropped and the scraped time stands.
 *
 * Pure, and separate from schema.ts, because this is the half worth being sure
 * about.
 */

export type ListingStatus = 'scheduled' | 'cancelled' | 'postponed' | 'sold_out';
export const LISTING_STATUSES: ListingStatus[] = ['scheduled', 'cancelled', 'postponed', 'sold_out'];

/** The statuses that take an event off the list. Sold out only gets a label. */
export function hidesEvent(status: string): boolean {
  return status === 'cancelled' || status === 'postponed';
}

/** How far back a corrected start may be: the same day, give or take. */
const PAST_LIMIT_MS = 24 * 3600_000;

/** The listing text a quotation has to be found in. */
export interface WhenText {
  title: string;
  description: string;
  /** When the app first saw the listing, which decides the year of a date that names none. */
  firstSeen?: string;
  /** The start as scraped, ISO. A "correction" to the same moment is not one. */
  startTime: string;
}

export interface WhenCorrection {
  /** ISO, as stored. A date-only start is local midnight, as parseWhen makes it. */
  startTime: string;
  endTime: string;
  dateOnly: boolean;
  /** The listing's own words, as quoted. */
  note: string;
  /** What was kept out of the model's answer though the correction stands, for the task log. */
  dropped: string[];
}

export interface WhenOutcome {
  correction?: WhenCorrection;
  status?: { status: Exclude<ListingStatus, 'scheduled'>; note: string };
  /** Why an answer was thrown away, for the task log. Empty when nothing was. */
  rejected: string[];
}

/** Case, spacing and the curly forms of quotes and dashes made the same, so a quotation survives being retyped. */
export function normalizeQuote(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether `quote` is words of `text`, which is the whole test for "copied verbatim". */
export function quotedFrom(quote: string, text: string): boolean {
  const q = normalizeQuote(quote);
  return q.length > 0 && normalizeQuote(text).includes(q);
}

const LOCAL_START = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

/** "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" in local time, as the app stores a time, or null for anything else. */
function readLocal(text: unknown): { startTime: string; dateOnly: boolean; at: Date } | null {
  if (typeof text !== 'string') return null;
  const m = LOCAL_START.exec(text.trim());
  if (!m) return null;
  const when = parseWhen(text.trim());
  if (!when) return null;
  const at = new Date(when.startTime);
  // Read back, as parseWhen does for a bare date: a time of 25:61 must not roll over into a real one.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  if (m[4] !== undefined && (at.getHours() !== Number(m[4]) || at.getMinutes() !== Number(m[5]))) return null;
  return { startTime: when.startTime, dateOnly: when.dateOnly, at };
}

const nonEmpty = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * A correction to the start, or the reason there is not to be one.
 *
 * Each test is cheap and none is optional: the model's start must be a real
 * date, the quotation must be in the listing, the app's own reader must make
 * the same day (and the same hour, where both state one) of the quotation, and
 * the result must be somewhere a start could plausibly be.
 */
function judgeStart(raw: Record<string, unknown>, text: WhenText, now: Date): WhenCorrection | string {
  const quote = nonEmpty(raw.whenSource);
  let claimed = readLocal(raw.start);
  if (!claimed) return 'no usable start given';
  if (!quotedFrom(quote, `${text.title}\n${text.description}`)) return 'its quotation is not in the listing';

  const from = text.firstSeen && !Number.isNaN(Date.parse(text.firstSeen)) ? new Date(text.firstSeen) : null;
  const read = whenFromText(quote, from, now);
  if (!read) return 'the quotation does not read as a date';
  const said = new Date(read.startTime);
  if (
    said.getFullYear() !== claimed.at.getFullYear() ||
    said.getMonth() !== claimed.at.getMonth() ||
    said.getDate() !== claimed.at.getDate()
  ) {
    return 'the quotation reads as a different day';
  }
  // A time the quotation does not state is the model's own invention: the day
  // is kept and the time dropped, so the card says "Saturday" and no hour.
  const dropped: string[] = [];
  if (read.dateOnly && !claimed.dateOnly) {
    claimed = readLocal(String(raw.start).trim().slice(0, 10))!;
    dropped.push('time dropped: the quotation states a day only');
  }
  if (!read.dateOnly && !claimed.dateOnly && (said.getHours() !== claimed.at.getHours() || said.getMinutes() !== claimed.at.getMinutes())) {
    return 'the quotation reads as a different time';
  }
  const ahead = claimed.at.getTime() - now.getTime();
  if (ahead < -PAST_LIMIT_MS || ahead > FUTURE_HORIZON_MS) return 'the corrected start is out of range';
  if (Date.parse(claimed.startTime) === Date.parse(text.startTime)) return 'it is the time already shown';

  // An end is held to less: the quotation was chosen to support the start, so
  // the end is kept only when it is a believable run from it.
  let end = readLocal(raw.end);
  if (end && read.dateOnly && !end.dateOnly) {
    end = readLocal(String(raw.end).slice(0, 10));
    dropped.push('end time dropped: the quotation states a day only');
  }
  const run = end ? Date.parse(end.startTime) - Date.parse(claimed.startTime) : NaN;
  let endTime = '';
  if (end && run > 0 && run <= MAX_DURATION_MS) {
    // A bare date ends at the close of its day, as parseEnd reads one.
    endTime = end.dateOnly
      ? new Date(end.at.getFullYear(), end.at.getMonth(), end.at.getDate() + 1).toISOString()
      : end.startTime;
  }
  return { startTime: claimed.startTime, endTime, dateOnly: claimed.dateOnly, note: quote, dropped };
}

/**
 * Judge the date check's answer against the listing.
 *
 * `raw` is the model's object as parsed, with every field untrusted.
 */
export function checkWhen(raw: Record<string, unknown>, text: WhenText, now: Date = new Date()): WhenOutcome {
  const out: WhenOutcome = { rejected: [] };

  if (raw.whenVerdict === 'wrong') {
    const judged = judgeStart(raw, text, now);
    if (typeof judged === 'string') out.rejected.push(`date left alone: ${judged}`);
    else {
      out.correction = judged;
      out.rejected.push(...judged.dropped);
    }
  }

  const status = raw.status;
  if (status === 'cancelled' || status === 'postponed' || status === 'sold_out') {
    const quote = nonEmpty(raw.statusSource);
    if (quotedFrom(quote, `${text.title}\n${text.description}`)) out.status = { status, note: quote };
    else out.rejected.push(`${status} ignored: its quotation is not in the listing`);
  }
  return out;
}

/** What goes in the "hidden" reason for a cancelled or postponed event. */
export function statusReason(status: string, note: string): string {
  const label = status === 'postponed' ? 'Postponed' : 'Cancelled';
  return note ? `${label} — “${note}”` : label;
}
