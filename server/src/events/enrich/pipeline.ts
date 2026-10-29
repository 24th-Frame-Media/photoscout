import { db, getKv, getSettings, saveSettings, setKv } from '../db.js';
import { TaskLog, TaskResult } from '../tasks/registry.js';
import { checkRole, chatJson, listServiceModels, poolKey } from '../llm/router.js';
import { allServices, ollamaUrl, servicesFor } from '../llm/services.js';
import { LlmError, type LlmService, type LlmServiceStatus, type LlmStrategy, type ModelInfo } from '../llm/types.js';
import { cleanDescription, findBoilerplate } from './boilerplate.js';
import { clearVerdicts } from './dupeStore.js';
import { flyerBacklog } from './visionPipeline.js';
import { cleanAddress, validateAddress } from '../validate.js';
import { defaultRegionFrom } from '../regions.js';
import {
  buildPrompt,
  buildSchema,
  contentHash,
  EnrichInput,
  EnrichJob,
  readVerdict,
} from './schema.js';

/**
 * Reading the listings with a local model, as a background task.
 *
 * Deliberately not part of the event refresh. A pass of a few dozen events is a
 * minute or two of local inference, and a refresh that already carries a
 * thirty-minute watchdog is the wrong place to put it — a slow model would look
 * exactly like a hung source. On its own schedule it can take as long as it
 * likes without holding anything up.
 *
 * The cost of that is one cycle of latency: a venue the model reads out of a
 * description is picked up by the next refresh's geocoding pass rather than the
 * same one.
 */

/** Seconds one event may take before it is given up on. */
const EVENT_TIMEOUT_MS = 90_000;

interface Row {
  id: number;
  url: string;
  title: string;
  description: string;
  venue_name: string;
  address: string;
  category: string;
  start_time: string;
  source: string;
  first_seen_at: string | null;
  date_only: number;
}

/**
 * The site boilerplate across every listing, found once per pass. One cheap
 * SELECT: it has to see all of them, archived too, since a host's repeats are
 * evidence whichever of its listings are still upcoming.
 */
export function loadBoilerplate(): Set<string> {
  return findBoilerplate(
    db.prepare('SELECT url, title, description FROM events').all() as unknown as {
      url: string; title: string; description: string | null;
    }[]
  );
}

function toInput(row: Row): EnrichInput {
  return {
    title: row.title,
    description: row.description ?? '',
    venueName: row.venue_name ?? '',
    address: row.address ?? '',
    category: row.category ?? '',
    startTime: row.start_time,
    source: row.source,
    firstSeen: row.first_seen_at ?? undefined,
    dateOnly: row.date_only === 1,
  };
}

/**
 * The region a model-supplied venue/address is tidied against, cached for a
 * minute so a run of many events does not scan the table once each. Same
 * source of truth as insertRaw's own region: whatever the stored addresses
 * already agree on.
 */
let cachedRegion: { at: number; value: string } | null = null;
function llmRegion(): string {
  if (cachedRegion && Date.now() - cachedRegion.at < 60_000) return cachedRegion.value;
  const rows = db.prepare("SELECT address FROM events WHERE address != ''").all() as unknown as {
    address: string;
  }[];
  cachedRegion = { at: Date.now(), value: defaultRegionFrom(rows.map((r) => r.address)) };
  return cachedRegion.value;
}

/**
 * The same tidying insertRaw runs on a scraped venue/address, applied to what
 * the model reads out of a description or a flyer — untidied, it stores
 * "Bathurst, NSW, Australia, Bathurst" as literally as any other source would.
 */
export function cleanExtractedVenue(venue: string | undefined): string {
  return venue ? cleanAddress(venue, llmRegion()) : '';
}
export function cleanExtractedAddress(address: string | undefined): string {
  return validateAddress(address, llmRegion());
}

export function enabledJobs(): EnrichJob[] {
  addJobsOnce();
  const configured = getSettings().llmJobs ?? [];
  const known: EnrichJob[] = ['vet', 'describe', 'rename', 'classify', 'extract', 'score', 'when', 'dupes'];
  return known.filter((j) => configured.includes(j));
}

/**
 * The jobs that read one event at a time. The duplicate check works on pairs,
 * has no field in the per-event schema, and must not be part of the cache key
 * that decides whether an event has been read. See dupes.ts.
 */
export function eventJobs(): EnrichJob[] {
  return enabledJobs().filter((j) => j !== 'dupes');
}

/**
 * Switch on, once each, jobs added after someone's settings were saved.
 *
 * Saved settings carry their own list of jobs, so a job added later is off for
 * everyone who has ever pressed Save. Once rather than on every read, so
 * turning one off in Settings stays off.
 */
function addJobsOnce(): void {
  const added: [flag: string, job: EnrichJob, wanted: (jobs: string[]) => boolean][] = [
    ['migrate:llm-rename-job', 'rename', (jobs) => jobs.includes('describe')],
    ['migrate:llm-vet-job', 'vet', (jobs) => jobs.length > 0],
    ['migrate:llm-when-job', 'when', (jobs) => jobs.length > 0],
    ['migrate:llm-dupes-job', 'dupes', (jobs) => jobs.length > 0],
  ];
  for (const [flag, job, wanted] of added) {
    if (getKv(flag)) continue;
    setKv(flag, new Date().toISOString());
    if (!getKv('settings')) continue;
    const settings = getSettings();
    const jobs = settings.llmJobs ?? [];
    if (wanted(jobs) && !jobs.includes(job)) saveSettings({ ...settings, llmJobs: [...jobs, job] });
  }
}

/** Whether new events wait for the model's say-so before they are shown. */
export function vettingOn(): boolean {
  return Boolean(getSettings().llmEnabled) && enabledJobs().includes('vet');
}

/**
 * Events worth spending inference on, newest find first.
 *
 * "Worth" means the stored fingerprint does not match what the row says now, so
 * this covers new events, edited ones, and everything already in the database
 * the first time the task runs. Newest first because new events wait for the
 * vet job before they are shown; a backlog of old ones can take its time.
 * Archived rows are skipped: nobody is scouting a
 * shoot that has been and gone.
 *
 * Selected in bulk and filtered in memory rather than joined on the hash,
 * because the hash depends on settings the database knows nothing about.
 */
export function pendingEvents(model: string, jobs: EnrichJob[], limit: number): Row[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.url, e.title, e.description, e.venue_name, e.address, e.category,
              e.start_time, e.source, e.first_seen_at, e.date_only, x.content_hash AS hash
         FROM events e
         LEFT JOIN event_enrichment x ON x.event_id = e.id
        WHERE e.archived = 0
        ORDER BY e.first_seen_at DESC, e.id DESC`
    )
    .all() as unknown as (Row & { hash: string | null })[];

  // Cleaned here, before the hash, so what is hashed is what the model is shown:
  // an event last read with a site's blurb as its description is read again.
  const boilerplate = loadBoilerplate();
  for (const row of rows) row.description = cleanDescription(boilerplate, { ...row, description: row.description ?? '' });

  const out: Row[] = [];
  for (const row of rows) {
    if (row.hash === contentHash(toInput(row), model, jobs)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** How many events are waiting, for the status display. */
export function backlogCount(): number {
  const settings = getSettings();
  const jobs = eventJobs();
  if (jobs.length === 0) return 0;
  // Cheap enough at this scale, and only asked for when somebody is looking.
  return pendingEvents(poolKey('text', settings), jobs, Number.MAX_SAFE_INTEGER).length;
}

const recordStmt = () =>
  db.prepare(
    `INSERT INTO event_enrichment (event_id, content_hash, model, ok, note, enriched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       model = excluded.model,
       ok = excluded.ok,
       note = excluded.note,
       enriched_at = excluded.enriched_at`
  );

/**
 * One pass.
 *
 * Every failure mode ends the same way — the event keeps its scraped values and
 * the run carries on — because none of this is load-bearing. The one exception
 * is being unable to reach Ollama at all, which stops the pass rather than
 * failing every event in turn against a server that is not there.
 */
export async function runEnrichment(log: TaskLog): Promise<TaskResult> {
  const settings = getSettings();
  const jobs = eventJobs();
  if (jobs.length === 0) {
    return enabledJobs().length === 0
      ? { ok: false, message: 'No enrichment jobs are switched on' }
      : { ok: true, message: 'no per-event jobs are switched on' };
  }

  const check = await checkRole('text', settings);
  if (!check.ok) return { ok: false, message: check.message };
  const model = poolKey('text', settings);

  const limit = Math.max(1, settings.llmMaxPerRun ?? 40);
  const rows = pendingEvents(model, jobs, limit);
  if (rows.length === 0) return { ok: true, message: 'nothing new to read' };

  const record = recordStmt();
  const update = db.prepare(
    `UPDATE events SET llm_description = ?, llm_title = ?, llm_category = ?, llm_venue_name = ?,
                       llm_address = ?, llm_price_text = ?, llm_photo_score = ?,
                       llm_start_time = ?, llm_end_time = ?, llm_date_only = ?, llm_when_note = ?,
                       llm_status = ?, llm_status_note = ?,
                       -- A place the model read is worth looking up on the map.
                       geocode_tried = CASE WHEN lat IS NULL AND (? != '' OR ? != '') THEN 0 ELSE geocode_tried END
     WHERE id = ?`
  );
  // Only when the vet job answered, and the time of the first answer kept:
  // notifications count an event as new from when it was first let through.
  const vet = db.prepare(
    `UPDATE events SET llm_vet_note = ?,
                       llm_vetted_at = CASE WHEN llm_vetted_at = '' THEN ? ELSE llm_vetted_at END
     WHERE id = ?`
  );

  let done = 0;
  let failed = 0;
  const started = Date.now();
  log(`${rows.length} to read with ${model}`);

  for (const row of rows) {
    const input = toInput(row);
    const hash = contentHash(input, model, jobs);
    try {
      const raw = await chatJson('text', {
        prompt: buildPrompt(input, jobs),
        // Per event, not per run: which fields it may answer depends on which
        // ones this listing left blank.
        schema: buildSchema(jobs, input),
        timeoutMs: EVENT_TIMEOUT_MS,
      }, settings);
      const verdict = readVerdict(raw, jobs, input);
      const venueName = cleanExtractedVenue(verdict.venueName);
      const address = cleanExtractedAddress(verdict.address);
      update.run(
        verdict.description ?? '',
        verdict.title ?? '',
        verdict.category ?? '',
        venueName,
        address,
        verdict.priceText ?? '',
        verdict.photoScore ?? null,
        verdict.startTime ?? '',
        verdict.endTime ?? '',
        verdict.startTime ? Number(verdict.dateOnly) : null,
        verdict.whenNote ?? '',
        verdict.status ?? '',
        verdict.statusNote ?? '',
        venueName,
        address,
        row.id
      );
      // A correction thrown away is worth a line: it is how a prompt that the
      // model keeps getting wrong, or a quotation it keeps mangling, shows up.
      for (const why of verdict.whenRejected ?? []) log(`${row.title}: ${why}`);
      if (verdict.notEvent !== undefined) vet.run(verdict.notEvent, new Date().toISOString(), row.id);
      record.run(row.id, hash, model, 1, '', new Date().toISOString());
      done++;
    } catch (err) {
      const message = (err as Error).message;
      failed++;
      // Remembered as tried, so one unreadable listing cannot hold up the
      // queue by being picked first every single run.
      record.run(row.id, hash, model, 0, message.slice(0, 200), new Date().toISOString());
      log(`${row.title}: ${message}`);
      // A server that has gone away will fail every remaining event the same
      // way; stop rather than spend the whole budget finding that out.
      if (err instanceof LlmError && /cannot reach|No answer/i.test(message)) {
        return { ok: false, message: `${message} after ${done} event${done === 1 ? '' : 's'}` };
      }
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const left = backlogCount();
  log(`${done} read, ${failed} failed, ${seconds}s`);
  return {
    ok: failed < rows.length,
    message: `read ${done}${failed ? `, ${failed} failed` : ''} in ${seconds}s${left ? `, ${left} left` : ''}`,
  };
}

export interface LlmStatus {
  enabled: boolean;
  url: string;
  model: string;
  jobs: EnrichJob[];
  reachable: boolean;
  /** Why not, when unreachable. */
  problem: string;
  models: { name: string; size: number }[];
  modelInstalled: boolean;
  backlog: number;
  /** Events already read, so a reset can say what it is throwing away. */
  read: number;
  /** The flyer pass, which shares the server and the model list. */
  vision: {
    enabled: boolean;
    model: string;
    modelInstalled: boolean;
    backlog: number;
    read: number;
  };
  /** Which service takes the next request when several can do the same job. */
  strategy: LlmStrategy;
  /** Every service, with whether it answers and has its model. Never carries a key. */
  services: LlmServiceStatus[];
}

interface Probe {
  reachable: boolean;
  problem: string;
  models: ModelInfo[];
  modelAvailable: boolean;
}

const NOT_SET_UP: Probe = {
  reachable: false,
  problem: 'No service is set up for this job',
  models: [],
  modelAvailable: false,
};

/** Asks one service what it has. Never throws: a failure is the answer. */
async function probe(s: LlmService): Promise<Probe> {
  if (!s.enabled) return { reachable: false, problem: 'Switched off', models: [], modelAvailable: false };
  try {
    const models = await listServiceModels(s);
    return { reachable: true, problem: '', models, modelAvailable: models.some((m) => m.name === s.model) };
  } catch (err) {
    return { reachable: false, problem: (err as Error).message, models: [], modelAvailable: false };
  }
}

export async function getLlmStatus(): Promise<LlmStatus> {
  const settings = getSettings();
  const jobs = enabledJobs();
  const all = allServices(settings);
  // Every enabled service asked at once, so one that is down cannot hold up the rest.
  const settled = await Promise.allSettled(all.map(probe));
  const probes = settled.map((r) =>
    r.status === 'fulfilled' ? r.value : { ...NOT_SET_UP, problem: String(r.reason) }
  );
  const probeOf = (id: string | undefined): Probe => {
    const i = all.findIndex((s) => s.id === id);
    return i >= 0 ? probes[i] : NOT_SET_UP;
  };

  // The first service each job would use. The top-level fields below report
  // on these, so the tab reads the same whether it has services or not.
  const textFirst = servicesFor('text', settings)[0] ?? all.find((s) => s.roles.includes('text'));
  const visionFirst = servicesFor('vision', settings)[0] ?? all.find((s) => s.roles.includes('vision'));
  const text = textFirst ? probeOf(textFirst.id) : NOT_SET_UP;
  const vision = visionFirst ? probeOf(visionFirst.id) : NOT_SET_UP;

  return {
    enabled: Boolean(settings.llmEnabled),
    url: textFirst
      ? textFirst.provider === 'ollama'
        ? ollamaUrl(textFirst.baseUrl)
        : textFirst.baseUrl
      : ollamaUrl(settings.llmUrl),
    model: textFirst ? textFirst.model : (settings.llmModel ?? ''),
    jobs,
    backlog: jobs.length ? backlogCount() : 0,
    read: countRead('event_enrichment'),
    reachable: text.reachable,
    problem: text.problem,
    models: text.models,
    modelInstalled: text.modelAvailable,
    vision: {
      enabled: Boolean(settings.visionEnabled),
      model: visionFirst ? visionFirst.model : (settings.visionModel ?? ''),
      modelInstalled: vision.modelAvailable,
      backlog: flyerBacklog(),
      read: countRead('event_vision'),
    },
    strategy: settings.llmStrategy ?? 'least_busy',
    services: all.map((s, i) => ({
      id: s.id,
      label: s.label,
      provider: s.provider,
      model: s.model,
      roles: s.roles,
      enabled: s.enabled,
      reachable: probes[i].reachable,
      problem: probes[i].problem,
      models: probes[i].models,
      modelAvailable: probes[i].modelAvailable,
    })),
  };
}

/** How many events a pass has already looked at. Table name is ours, not input. */
function countRead(table: 'event_enrichment' | 'event_vision'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Forget every verdict, so the next pass reconsiders everything. */
export function clearEnrichment(): number {
  const changed = db.prepare('DELETE FROM event_enrichment').run().changes;
  clearVerdicts();
  db.exec(
    `UPDATE events SET llm_description = '', llm_title = '', llm_category = '', llm_venue_name = '',
                       llm_address = '', llm_price_text = '', llm_photo_score = NULL,
                       llm_vet_note = '', llm_vetted_at = '',
                       llm_start_time = '', llm_end_time = '', llm_date_only = NULL,
                       llm_when_note = '', llm_status = '', llm_status_note = ''`
  );
  return Number(changed);
}
