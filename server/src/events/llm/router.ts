import { getSettings } from '../db.js';
import type { Settings } from '../sources/types.js';
import { candidatesFor, legacyServices, ollamaUrl, servicesFor } from './services.js';
import { anthropicProvider } from './providers/anthropic.js';
import { geminiProvider } from './providers/gemini.js';
import { ollamaProvider } from './providers/ollama.js';
import { openaiProvider } from './providers/openai.js';
import {
  LlmError,
  type JsonRequest,
  type LlmRole,
  type LlmService,
  type LlmStrategy,
  type ModelInfo,
  type Provider,
  type ProviderId,
  type TextRequest,
} from './types.js';

/**
 * Sending a job to whichever of its services should take it.
 *
 * A service is picked by the strategy in Settings. If it fails, each other
 * service that can do the job is tried once, in order, before the job is given
 * up. Only the callers' own failures are reported: a service that is not there
 * is not something the listing pass should wait on.
 */

const registry: Record<ProviderId, Provider> = {
  ollama: ollamaProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

let providers: Record<ProviderId, Provider> = registry;

/** Swap in fake providers for a test. The returned function puts the real ones back. */
export function setProvidersForTest(overrides: Partial<Record<ProviderId, Provider>>): () => void {
  const saved = providers;
  providers = { ...saved, ...overrides };
  return () => {
    providers = saved;
  };
}

/** Requests in flight per service, for least-busy. In memory: a restart starts everything at zero. */
const inFlight = new Map<string, number>();
/** Where round-robin has got to. */
let turn = 0;

const load = (s: LlmService): number => inFlight.get(s.id) ?? 0;

function pick(pool: LlmService[], strategy: LlmStrategy): LlmService {
  if (strategy === 'round_robin') return pool[turn++ % pool.length];
  if (strategy === 'random') return pool[Math.floor(Math.random() * pool.length)];
  const least = Math.min(...pool.map(load));
  const idle = pool.filter((s) => load(s) === least);
  return idle[Math.floor(Math.random() * idle.length)];
}

async function attempt<T>(
  s: LlmService,
  model: string | undefined,
  call: (svc: LlmService, provider: Provider) => Promise<T>,
): Promise<T> {
  const svc = model ? { ...s, model } : s;
  inFlight.set(s.id, load(s) + 1);
  try {
    return await call(svc, providers[s.provider]);
  } finally {
    const left = load(s) - 1;
    if (left > 0) inFlight.set(s.id, left);
    else inFlight.delete(s.id);
  }
}

async function route<T>(
  role: LlmRole,
  settings: Settings,
  model: string | undefined,
  call: (svc: LlmService, provider: Provider) => Promise<T>,
): Promise<T> {
  let pool = servicesFor(role, settings);
  // A chat with its own model, on an install with no services and no listing
  // model of its own: the one Ollama is still the place to ask.
  if (pool.length === 0 && model && !(settings.llmServices?.length ?? 0)) {
    pool = [{ ...legacyServices(settings)[0], model }];
  }
  if (pool.length === 0) throw new LlmError('No model chosen in Settings');

  const first = pick(pool, settings.llmStrategy ?? 'least_busy');
  const order = [first, ...pool.filter((s) => s !== first)];
  let last: LlmService = first;
  let lastError: unknown;
  for (const s of order) {
    last = s;
    try {
      return await attempt(s, model, call);
    } catch (err) {
      // A cancelled call is the caller's own doing, not the service's: no second try.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  if (order.length === 1) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LlmError(`${last.label}: ${message}`);
}

/** One structured answer, from whichever service the role's pool picks. */
export function chatJson(role: LlmRole, req: JsonRequest, settings: Settings = getSettings()): Promise<unknown> {
  return route(role, settings, undefined, (s, p) => p.chatJson(s, req));
}

/**
 * One free-text answer. `model`, when given, replaces the picked service's model:
 * how a chat room asks for a particular model by name.
 */
export function chatText(
  role: LlmRole,
  req: TextRequest,
  opts: { model?: string } = {},
  settings: Settings = getSettings(),
): Promise<string> {
  return route(role, settings, opts.model || undefined, (s, p) => p.chatText(s, req));
}

/** The models one service reports it has. Throws when it cannot be asked. */
export function listServiceModels(s: LlmService): Promise<ModelInfo[]> {
  return providers[s.provider].listModels(s);
}

/**
 * Every model name the role's services report, once each. Throws only when
 * every one of them failed to answer; that is the case the caller has to explain.
 */
export async function listRoleModels(role: LlmRole, settings: Settings = getSettings()): Promise<string[]> {
  const pool = candidatesFor(role, settings);
  const names: string[] = [];
  let failed = 0;
  let lastError: unknown;
  for (const s of pool) {
    try {
      for (const m of await listServiceModels(s)) if (!names.includes(m.name)) names.push(m.name);
    } catch (err) {
      failed++;
      lastError = err;
    }
  }
  if (pool.length > 0 && failed === pool.length) throw lastError;
  return names;
}

export interface RoleCheck {
  ok: boolean;
  message: string;
}

async function problemWith(s: LlmService): Promise<string | null> {
  if (s.provider === 'ollama') {
    const url = ollamaUrl(s.baseUrl);
    try {
      const models = await providers.ollama.listModels(s);
      return models.some((m) => m.name === s.model) ? null : `${s.model} is not installed on ${url} — try: ollama pull ${s.model}`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  // A hosted service needs a key and an answer to the list. Whether the model
  // is among the listed is not checked: the list is not always complete.
  if (!s.apiKey.trim()) return 'No API key set';
  try {
    await providers[s.provider].listModels(s);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Whether a job can run at all: at least one of its services answers and has
 * its model. The message is the reason, for a status line or a log.
 */
export async function checkRole(role: LlmRole, settings: Settings = getSettings()): Promise<RoleCheck> {
  const pool = servicesFor(role, settings);
  if (pool.length === 0) return { ok: false, message: 'No model chosen in Settings' };
  const problems = await Promise.all(pool.map(async (s) => ({ s, problem: await problemWith(s) })));
  if (problems.some((p) => p.problem === null)) return { ok: true, message: '' };
  return {
    ok: false,
    message: problems
      .map(({ s, problem }) => (pool.length > 1 ? `${s.label}: ${problem}` : problem))
      .join('; '),
  };
}

/**
 * The string that stands for a job's model in caches, hashes and logs.
 *
 * One Ollama on its own is just its model name, which is what those caches
 * were keyed by before services existed, so they stay valid. Anything else is
 * the pool as a whole, so a change of service invalidates them as it should.
 */
export function poolKey(role: LlmRole, settings: Settings = getSettings()): string {
  const pool = servicesFor(role, settings);
  if (pool.length === 1 && pool[0].provider === 'ollama') return pool[0].model;
  return pool
    .map((s) => (s.provider === 'ollama' ? s.model : `${s.provider}:${s.model}`))
    .sort()
    .join('+');
}
