import { db } from '../db.js';
import { eventKey, pairId, pairKeys, PERSON_HASH } from './dupePairs.js';

/**
 * The model's answers about pairs of listings, in event_pair_verdict.
 *
 * Kept apart from dupePairs.ts, which opens no database, and from dupes.ts,
 * which asks the questions: the refresh reads the yes answers to join groups
 * and so must be able to import this without importing the model.
 */

/** Every answered pair, with the hash it was answered under. */
export function answeredPairs(): Map<string, string> {
  const rows = db.prepare('SELECT a_key, b_key, input_hash FROM event_pair_verdict').all() as unknown as {
    a_key: string;
    b_key: string;
    input_hash: string;
  }[];
  return new Map(rows.map((r) => [pairId(r.a_key, r.b_key), r.input_hash]));
}

export function recordVerdict(
  x: string, y: string, hash: string, same: boolean, reason: string, model: string
): void {
  const [a, b] = pairKeys(x, y);
  db.prepare(
    `INSERT INTO event_pair_verdict (a_key, b_key, input_hash, same, reason, model, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(a_key, b_key) DO UPDATE SET
       input_hash = excluded.input_hash,
       same = excluded.same,
       reason = excluded.reason,
       model = excluded.model,
       decided_at = excluded.decided_at`
  ).run(a, b, hash, same ? 1 : 0, reason, model, new Date().toISOString());
}

/** The pairs the model called one event, with why. */
export function joinedPairs(): { aKey: string; bKey: string; reason: string }[] {
  const rows = db.prepare('SELECT a_key, b_key, reason FROM event_pair_verdict WHERE same = 1').all() as unknown as {
    a_key: string;
    b_key: string;
    reason: string;
  }[];
  return rows.map((r) => ({ aKey: r.a_key, bKey: r.b_key, reason: r.reason }));
}

/**
 * A person split these listings apart: every pair among them the model had
 * joined becomes a "no" that no change to the listings can overturn. Pairs it
 * never joined are left alone, so they are still asked about if they come up.
 */
export function rejectPairs(listings: { source: string; source_id: string }[]): number {
  const keys = listings.map((l) => eventKey(l.source, l.source_id));
  const split = db.prepare(
    `UPDATE event_pair_verdict SET same = 0, input_hash = ?, model = 'person', decided_at = ?
      WHERE same = 1 AND a_key = ? AND b_key = ?`
  );
  let changed = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = pairKeys(keys[i], keys[j]);
      changed += Number(split.run(PERSON_HASH, now, a, b).changes);
    }
  }
  return changed;
}

/** Forget every answer, so the next pass asks again. */
export function clearVerdicts(): number {
  return Number(db.prepare('DELETE FROM event_pair_verdict').run().changes);
}

/** How many pairs have been answered, yes or no. */
export function countVerdicts(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM event_pair_verdict').get() as { n: number }).n;
}
