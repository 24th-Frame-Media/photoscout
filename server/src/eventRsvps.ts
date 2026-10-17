import type { Db } from './db.js';

/**
 * Who is going to an event, or interested in it.
 *
 * A crawled event is answered under its group key, the one user_event_state
 * uses. A community event keeps going only (see community_rsvps), so its
 * interested count is always 0. The counts are the same for everyone, so they
 * are read once per request, and banned accounts are left out of both the
 * counts and the names.
 */

export type RsvpStatus = 'going' | 'interested';
const STATUSES: readonly string[] = ['going', 'interested'];
export const isRsvpStatus = (v: unknown): v is RsvpStatus => typeof v === 'string' && STATUSES.includes(v);

export interface RsvpCounts { going: number; interested: number }
export interface Attendee { id: string; username: string; avatar: string }
export interface RsvpSummary extends RsvpCounts { mine: RsvpStatus | null; attendees: Attendee[] }

/** The names on an answer; the rest are only counted. */
const ATTENDEES_SHOWN = 12;
const NONE: RsvpCounts = { going: 0, interested: 0 };

export interface RsvpTotals {
  counts: Map<string, RsvpCounts>;
  mine: Map<string, RsvpStatus>;
}

/** Counts for every crawled event that has any answer, and the caller's own answer on each. One query each, however long the list. */
export function eventRsvpTotals(db: Db, userId: string | null): RsvpTotals {
  const rows = db.handle
    .prepare('SELECT r.event_group, r.status, COUNT(*) AS n FROM event_rsvps r JOIN users u ON u.id = r.user_id WHERE u.banned = 0 GROUP BY r.event_group, r.status')
    .all() as { event_group: string; status: RsvpStatus; n: number | bigint }[];
  const counts = new Map<string, RsvpCounts>();
  for (const r of rows) {
    const c = counts.get(r.event_group) ?? { ...NONE };
    c[r.status] = Number(r.n);
    counts.set(r.event_group, c);
  }
  const mine = new Map<string, RsvpStatus>();
  if (userId) {
    const own = db.handle.prepare('SELECT event_group, status FROM event_rsvps WHERE user_id = ?').all(userId) as { event_group: string; status: RsvpStatus }[];
    for (const r of own) mine.set(r.event_group, r.status);
  }
  return { counts, mine };
}

/** Pure: each event with its counts and the caller's own answer laid over it. */
export function withRsvps<T extends { group: string }>(events: T[], totals: RsvpTotals): (T & RsvpCounts & { myRsvp: RsvpStatus | null })[] {
  return events.map((ev) => ({ ...ev, ...(totals.counts.get(ev.group) ?? NONE), myRsvp: totals.mine.get(ev.group) ?? null }));
}

/** One crawled event's answer, for its RSVP route. */
export function eventRsvpSummary(db: Db, group: string, userId: string | null): RsvpSummary {
  const rows = db.handle
    .prepare('SELECT r.status, COUNT(*) AS n FROM event_rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_group = ? AND u.banned = 0 GROUP BY r.status')
    .all(group) as { status: RsvpStatus; n: number | bigint }[];
  const own = userId
    ? (db.handle.prepare('SELECT status FROM event_rsvps WHERE event_group = ? AND user_id = ?').get(group, userId) as { status: RsvpStatus } | undefined)
    : undefined;
  // Names are for a signed-in caller; a visitor gets the counts only.
  const attendees = userId
    ? (db.handle
        .prepare(
          `SELECT u.id, u.username, u.avatar FROM event_rsvps r JOIN users u ON u.id = r.user_id
            WHERE r.event_group = ? AND r.status = 'going' AND u.banned = 0 ORDER BY r.created_at, u.id LIMIT ?`
        )
        .all(group, ATTENDEES_SHOWN) as unknown as Attendee[])
    : [];
  const counts = { ...NONE };
  for (const r of rows) counts[r.status] = Number(r.n);
  return { ...counts, mine: own?.status ?? null, attendees };
}

/** One community event's answer, in the same shape as a crawled event's. */
export function communityRsvpSummary(db: Db, eventId: string, userId: string | null): RsvpSummary {
  const going = db.handle
    .prepare('SELECT COUNT(*) AS n FROM community_rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND u.banned = 0')
    .get(eventId) as { n: number | bigint };
  const mine: RsvpStatus | null = userId && db.handle.prepare('SELECT 1 FROM community_rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId) ? 'going' : null;
  // As above: the names only for someone signed in.
  const attendees = userId
    ? (db.handle
        .prepare(
          `SELECT u.id, u.username, u.avatar FROM community_rsvps r JOIN users u ON u.id = r.user_id
            WHERE r.event_id = ? AND u.banned = 0 ORDER BY r.created_at, u.id LIMIT ?`
        )
        .all(eventId, ATTENDEES_SHOWN) as unknown as Attendee[])
    : [];
  return { going: Number(going.n), interested: 0, mine, attendees };
}

/** One answer per person: a new one replaces the old, and its first time is kept. */
export function setEventRsvp(db: Db, userId: string, group: string, status: RsvpStatus): void {
  db.handle
    .prepare(`INSERT INTO event_rsvps (event_group, user_id, status, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(event_group, user_id) DO UPDATE SET status = excluded.status`)
    .run(group, userId, status, new Date().toISOString());
}

export function clearEventRsvp(db: Db, userId: string, group: string): void {
  db.handle.prepare('DELETE FROM event_rsvps WHERE event_group = ? AND user_id = ?').run(group, userId);
}
