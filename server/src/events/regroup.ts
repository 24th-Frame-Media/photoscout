import { db } from './db.js';
import { assignDedupeGroups, DedupeInput } from './dedupe.js';
import { joinGroups, eventKey } from './enrich/dupePairs.js';
import { joinedPairs } from './enrich/dupeStore.js';

/**
 * Work out which listings are one event, and store it on each row.
 *
 * The heuristic deduper decides first. Then every pair the model was asked
 * about and called one event is joined on top, so a group the heuristic could
 * not see is still one card. A pair either of whose listings a person grouped
 * by hand is left out: manual_group overrides the dedupe group wherever the two
 * differ, and a model's yes must not drag a listing a person placed into
 * another group. See enrich/dupes.ts.
 */
export function recomputeDedupeGroups(): void {
  const rows = db
    // The model's name where it gave one: a caption for a title matches nothing.
    .prepare("SELECT id, COALESCE(NULLIF(llm_title, ''), title) AS title, start_time AS startTime, end_time AS endTime, lat, lng, venue_name AS venueName, date_only AS dateOnly FROM events ORDER BY start_time ASC, id ASC")
    .all() as unknown as DedupeInput[];
  const groups = joinGroups(assignDedupeGroups(rows), modelPairs());
  const update = db.prepare('UPDATE events SET dedupe_group = ? WHERE id = ?');
  for (const [id, group] of groups) update.run(group, id);
}

/** The model's yes answers, as row ids, for the listings still here and not grouped by hand. */
function modelPairs(): [number, number][] {
  const joined = joinedPairs();
  if (joined.length === 0) return [];
  const rows = db.prepare('SELECT id, source, source_id, manual_group FROM events').all() as unknown as {
    id: number;
    source: string;
    source_id: string;
    manual_group: string;
  }[];
  const ids = new Map(rows.filter((r) => !r.manual_group).map((r) => [eventKey(r.source, r.source_id), r.id]));
  const out: [number, number][] = [];
  for (const { aKey, bKey } of joined) {
    const a = ids.get(aKey);
    const b = ids.get(bKey);
    if (a !== undefined && b !== undefined) out.push([a, b]);
  }
  return out;
}
