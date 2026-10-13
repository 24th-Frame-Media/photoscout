import crypto from 'node:crypto';
import type { Db } from './db.js';
import { DEFAULT_GOOD_TIMES } from './goodTimes.js';
import type { SuggestionInput } from './bodyLimits.js';

/**
 * Spots people suggest for the public map.
 *
 * A suggestion is not a spot: it sits in the moderators' queue until one of
 * them approves it, which makes a public spot owned by whoever suggested it,
 * or rejects it, which keeps the row as a record and nothing else.
 */

/** How many one account may send in a day, and how many may wait for a moderator at once. */
export const MAX_SUGGESTIONS_PER_DAY = 10;
export const MAX_OPEN_SUGGESTIONS = 20;

export interface SuggestionRow {
  id: string; user_id: string; name: string; notes: string; lat: number; lng: number;
  created_at: string; resolved_at: string | null; outcome: string | null; spot_id: string | null; username?: string | null;
}

export function suggestionJson(r: SuggestionRow) {
  return {
    id: r.id, name: r.name, notes: r.notes, lat: r.lat, lng: r.lng, createdAt: r.created_at,
    suggestedBy: r.username ?? null, resolvedAt: r.resolved_at, outcome: r.outcome, spotId: r.spot_id,
  };
}

/** Why this person cannot suggest another right now, or null. */
export function suggestionRefusal(db: Db, userId: string, now = Date.now()): string | null {
  const count = (sql: string, ...args: (string | number)[]) => Number((db.handle.prepare(sql).get(...args) as { n: number | bigint }).n);
  const since = new Date(now - 86_400_000).toISOString();
  if (count('SELECT COUNT(*) AS n FROM spot_suggestions WHERE user_id = ? AND created_at > ?', userId, since) >= MAX_SUGGESTIONS_PER_DAY) {
    return `You can suggest ${MAX_SUGGESTIONS_PER_DAY} spots a day`;
  }
  if (count('SELECT COUNT(*) AS n FROM spot_suggestions WHERE user_id = ? AND resolved_at IS NULL', userId) >= MAX_OPEN_SUGGESTIONS) {
    return `You already have ${MAX_OPEN_SUGGESTIONS} suggestions waiting for a moderator`;
  }
  return null;
}

export function addSuggestion(db: Db, userId: string, v: SuggestionInput): SuggestionRow {
  const id = crypto.randomUUID();
  db.handle
    .prepare('INSERT INTO spot_suggestions (id, user_id, name, notes, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, v.name, v.notes, v.lat, v.lng, new Date().toISOString());
  return db.handle.prepare('SELECT * FROM spot_suggestions WHERE id = ?').get(id) as unknown as SuggestionRow;
}

/** Waiting suggestions oldest first, then the latest settled ones. */
export function listSuggestions(db: Db): SuggestionRow[] {
  return db.handle
    .prepare(
      `SELECT s.*, u.username FROM spot_suggestions s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.resolved_at IS NOT NULL, CASE WHEN s.resolved_at IS NULL THEN s.created_at END, s.resolved_at DESC LIMIT 100`
    )
    .all() as unknown as SuggestionRow[];
}

export type Resolution = { ok: true; spotId: string | null } | { ok: false; status: 404 | 409; error: string };

/** Approve (makes the public spot) or reject one suggestion. A suggestion is settled once. */
export function resolveSuggestion(db: Db, id: string, staffId: string, action: 'approve' | 'reject'): Resolution {
  const row = db.handle.prepare('SELECT * FROM spot_suggestions WHERE id = ?').get(id) as unknown as SuggestionRow | undefined;
  if (!row) return { ok: false, status: 404, error: 'Not found' };
  if (row.resolved_at) return { ok: false, status: 409, error: 'Already settled' };
  const now = new Date().toISOString();
  let spotId: string | null = null;
  if (action === 'approve') {
    spotId = crypto.randomUUID();
    db.handle
      .prepare(
        `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, 'public', 'suggested', ?, ?, ?)`
      )
      .run(spotId, row.user_id, row.name, row.notes, row.lat, row.lng, JSON.stringify(DEFAULT_GOOD_TIMES), row.id, now, now);
  }
  db.handle
    .prepare('UPDATE spot_suggestions SET resolved_at = ?, resolved_by = ?, outcome = ?, spot_id = ? WHERE id = ?')
    .run(now, staffId, action === 'approve' ? 'approved' : 'rejected', spotId, id);
  return { ok: true, spotId };
}
