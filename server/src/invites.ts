import crypto from 'node:crypto';
import type { Db } from './db.js';

/**
 * Invites: one person asking another to come to an event.
 *
 * An invite names its event by kind and key, as the RSVP tables do, so it can
 * outlive the event. The event is looked up when the invite is shown, and an
 * invite whose event has gone still shows, with no event. Accepting one is an
 * RSVP; the routes in app.ts make it.
 */

export type InviteKind = 'event' | 'community';
export type InviteStatus = 'pending' | 'accepted' | 'dismissed';

/** How many invites one account may send in an hour. Asking again about one already sent costs nothing. */
export const MAX_INVITES_PER_HOUR = 30;
/** Most invites one account may have waiting with one person at a time: asking them again and again is pestering. */
export const MAX_PENDING_PER_PAIR = 5;
/** Most waiting invites one list carries; the count of all of them is separate. */
export const MAX_INVITES_LISTED = 50;

export interface InviteRow {
  id: string; event_kind: InviteKind; event_ref: string; from_user: string; to_user: string; created_at: string; status: InviteStatus;
}
export interface WaitingInvite extends InviteRow { from_name: string; from_avatar: string }

export function findInvite(db: Db, kind: InviteKind, ref: string, fromUser: string, toUser: string): InviteRow | undefined {
  return db.handle
    .prepare('SELECT * FROM event_invites WHERE event_kind = ? AND event_ref = ? AND from_user = ? AND to_user = ?')
    .get(kind, ref, fromUser, toUser) as unknown as InviteRow | undefined;
}

/** Sends the invite, or returns the one already sent for the same event and person. */
export function addInvite(db: Db, kind: InviteKind, ref: string, fromUser: string, toUser: string): InviteRow {
  db.handle
    .prepare('INSERT OR IGNORE INTO event_invites (id, event_kind, event_ref, from_user, to_user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), kind, ref, fromUser, toUser, new Date().toISOString());
  return findInvite(db, kind, ref, fromUser, toUser) as InviteRow;
}

/** How many invites this person has sent in the last hour. Counted in the table, so it survives a restart. */
export function sentLastHour(db: Db, userId: string, now = Date.now()): number {
  const since = new Date(now - 3_600_000).toISOString();
  return Number((db.handle.prepare('SELECT COUNT(*) AS n FROM event_invites WHERE from_user = ? AND created_at > ?').get(userId, since) as { n: number | bigint }).n);
}

/** How many invites this person has sent another that are still waiting. */
export function waitingBetween(db: Db, fromUser: string, toUser: string): number {
  const r = db.handle
    .prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE from_user = ? AND to_user = ? AND status = 'pending'`)
    .get(fromUser, toUser) as { n: number | bigint };
  return Number(r.n);
}

/** An invite, but only to the person it was sent to: anyone else gets nothing back, not even that it exists. */
export function inviteTo(db: Db, id: string, userId: string): InviteRow | undefined {
  return db.handle.prepare('SELECT * FROM event_invites WHERE id = ? AND to_user = ?').get(id, userId) as unknown as InviteRow | undefined;
}

export function setInviteStatus(db: Db, id: string, status: 'accepted' | 'dismissed'): void {
  db.handle.prepare('UPDATE event_invites SET status = ? WHERE id = ?').run(status, id);
}

/** Waiting invites from people who are not banned, newest first. Insertion order breaks a tie within one millisecond. */
export function waitingInvites(db: Db, userId: string): WaitingInvite[] {
  return db.handle
    .prepare(
      `SELECT i.*, u.username AS from_name, u.avatar AS from_avatar FROM event_invites i JOIN users u ON u.id = i.from_user
        WHERE i.to_user = ? AND i.status = 'pending' AND u.banned = 0 ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`
    )
    .all(userId, MAX_INVITES_LISTED) as unknown as WaitingInvite[];
}

/** Every waiting invite, not only the ones listed. */
export function waitingInviteCount(db: Db, userId: string): number {
  const r = db.handle
    .prepare(`SELECT COUNT(*) AS n FROM event_invites i JOIN users u ON u.id = i.from_user WHERE i.to_user = ? AND i.status = 'pending' AND u.banned = 0`)
    .get(userId) as { n: number | bigint };
  return Number(r.n);
}
