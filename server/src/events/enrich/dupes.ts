import { db, getSettings } from '../db.js';
import { TaskLog, TaskResult } from '../tasks/registry.js';
import { checkRole, chatJson, poolKey } from '../llm/router.js';
import { LlmError } from '../llm/types.js';
import { recomputeDedupeGroups } from '../regroup.js';
import { bumpEventsVersion } from '../events.js';
import {
  buildDupePrompt,
  buildDupeSchema,
  candidatePairs,
  type DupeEvent,
  eventKey,
  readDupeVerdict,
} from './dupePairs.js';
import { answeredPairs, recordVerdict } from './dupeStore.js';
import { cleanDescription } from './boilerplate.js';
import { enabledJobs, loadBoilerplate } from './pipeline.js';

/**
 * The duplicate check, as a pass of its own after the per-event one.
 *
 * It is not a field of the per-event schema because its unit is a pair, and
 * its answer is not stored beside a listing but joins two of them. It runs from
 * the same task as the per-event pass (see tasks.ts) so there is one schedule,
 * one switch and one place the model's time is accounted for.
 */

/** Seconds one pair may take before it is given up on. */
const PAIR_TIMEOUT_MS = 90_000;

/** Upcoming listings as the pair check sees them. */
export function loadEvents(): DupeEvent[] {
  const rows = db
    .prepare(
      `SELECT id, source, source_id, COALESCE(NULLIF(llm_title, ''), title) AS title, title AS raw_title, url, description,
              venue_name, address, start_time, end_time, date_only, lat, lng, dedupe_group, manual_group
         FROM events
        WHERE archived = 0`
    )
    .all() as unknown as {
      id: number; url: string; raw_title: string; source: string; source_id: string; title: string; description: string | null;
      venue_name: string | null; address: string | null; start_time: string; end_time: string | null;
      date_only: number; lat: number | null; lng: number | null; dedupe_group: string; manual_group: string;
    }[];
  // A site's generic blurb says nothing about either listing and would make two
  // of them look alike; the pair is shown without it, as the per-event pass is.
  const boilerplate = loadBoilerplate();
  return rows.map((r) => ({
    id: r.id,
    key: eventKey(r.source, r.source_id),
    title: r.title,
    description: cleanDescription(boilerplate, { url: r.url ?? '', title: r.raw_title, description: r.description }),
    venueName: r.venue_name ?? '',
    address: r.address ?? '',
    startTime: r.start_time,
    endTime: r.end_time,
    dateOnly: r.date_only === 1,
    lat: r.lat,
    lng: r.lng,
    source: r.source,
    group: r.dedupe_group,
    manual: Boolean(r.manual_group),
  }));
}

/**
 * One pass: ask about the closest unanswered pairs, keep every answer, and
 * regroup if any of them was a yes.
 *
 * Failing a pair leaves it unanswered, so it is simply asked again next time.
 * That is deliberate and cheaper than remembering failures: the cap, not the
 * failures, bounds the work, and a model that is down stops the pass anyway.
 */
export async function runDupes(log: TaskLog): Promise<TaskResult> {
  if (!enabledJobs().includes('dupes')) return { ok: true, message: 'duplicate check is off' };
  const settings = getSettings();
  const check = await checkRole('text', settings);
  if (!check.ok) return { ok: false, message: check.message };
  const model = poolKey('text', settings);

  const pairs = candidatePairs(loadEvents(), answeredPairs());
  if (pairs.length === 0) return { ok: true, message: 'no pairs to compare' };
  log(`${pairs.length} pair${pairs.length === 1 ? '' : 's'} to compare with ${model}`);

  let same = 0;
  let different = 0;
  let failed = 0;
  for (const { a, b, hash } of pairs) {
    try {
      const raw = await chatJson('text', {
        prompt: buildDupePrompt(a, b),
        schema: buildDupeSchema(),
        timeoutMs: PAIR_TIMEOUT_MS,
      }, settings);
      const verdict = readDupeVerdict(raw);
      if (!verdict) throw new Error('not an answer');
      recordVerdict(a.key, b.key, hash, verdict.same, verdict.reason, model);
      if (verdict.same) {
        same++;
        log(`${a.title} = ${b.title}: ${verdict.reason}`);
      } else {
        different++;
      }
    } catch (err) {
      const message = (err as Error).message;
      failed++;
      log(`${a.title} / ${b.title}: ${message}`);
      if (err instanceof LlmError && /cannot reach|No answer/i.test(message)) {
        return { ok: false, message: `${message} after ${same + different} pair${same + different === 1 ? '' : 's'}` };
      }
    }
  }

  if (same > 0) {
    recomputeDedupeGroups();
    bumpEventsVersion();
  }
  return {
    ok: failed < pairs.length,
    message: `compared ${same + different}: ${same} joined${failed ? `, ${failed} failed` : ''}`,
  };
}
