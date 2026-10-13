import crypto from 'node:crypto';
import type { Db } from './db.js';

/**
 * The secret in a person's calendar subscription link.
 *
 * A calendar app cannot sign in, so the link itself is the credential. It is a
 * random value shown once; only its SHA-256 is stored, so the table cannot be
 * used to subscribe as anyone. Making a new one replaces the old, which
 * stops working at once. A suspended account's link is deleted (see
 * setUserBanned) and the lookup also refuses a suspended owner.
 */

const hashOf = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/** Make (or replace) this person's token. The only time the token itself is available. */
export function issueCalendarToken(db: Db, userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.handle
    .prepare(
      `INSERT INTO calendar_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`
    )
    .run(userId, hashOf(token), new Date().toISOString());
  return token;
}

export function revokeCalendarToken(db: Db, userId: string): boolean {
  return Number(db.handle.prepare('DELETE FROM calendar_tokens WHERE user_id = ?').run(userId).changes) > 0;
}

/** When this person made their link, or null if they have none. */
export function calendarTokenInfo(db: Db, userId: string): { createdAt: string } | null {
  const row = db.handle.prepare('SELECT created_at FROM calendar_tokens WHERE user_id = ?').get(userId) as { created_at: string } | undefined;
  return row ? { createdAt: row.created_at } : null;
}

/** Whose link this is, or null for anything that is not a live one. */
export function userForCalendarToken(db: Db, token: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = db.handle
    .prepare('SELECT t.user_id FROM calendar_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.banned = 0')
    .get(hashOf(token)) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}
