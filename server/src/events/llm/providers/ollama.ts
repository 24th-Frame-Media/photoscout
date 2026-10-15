/**
 * Talking to a local Ollama.
 *
 * Small on purpose: one chat call with a JSON Schema attached, and a way to ask
 * which models are installed. Nothing is streamed, because the caller wants one
 * object rather than a typewriter effect. The request bodies here are what the
 * listing pass and the flyer reader have always sent; change them with care.
 */
import { LlmError, type ChatMessage, type LlmService, type ModelInfo, type Provider } from '../types.js';
import { ollamaUrl } from '../services.js';

export type OllamaModel = ModelInfo;

export class OllamaError extends LlmError {}

const TAGS_TIMEOUT_MS = 4000;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Which models are installed. Doubles as the reachability check. */
export async function listModels(url: string): Promise<OllamaModel[]> {
  const res = await withTimeout(TAGS_TIMEOUT_MS, (signal) =>
    fetch(`${base(url)}/api/tags`, { signal }).catch((err: Error) => {
      throw new OllamaError(
        err.name === 'AbortError' ? `No answer from ${url}` : `Cannot reach ${url}`
      );
    })
  );
  if (!res.ok) throw new OllamaError(`${url} answered HTTP ${res.status}`);
  const body = (await res.json()) as { models?: { name?: string; size?: number }[] };
  return (body.models ?? [])
    .filter((m): m is { name: string; size: number } => typeof m.name === 'string')
    .map((m) => ({ name: m.name, size: m.size ?? 0 }));
}

export interface ChatOptions {
  url: string;
  model: string;
  prompt: string;
  /** JSON Schema. Ollama constrains decoding to it rather than merely asking. */
  schema: Record<string, unknown>;
  timeoutMs: number;
  /**
   * Minutes to keep the model resident between calls. A pass does dozens of
   * these back to back, and reloading several gigabytes between each would cost
   * far more than the inference.
   */
  keepAliveMinutes?: number;
  /** Base64 JPEG/PNG data, for the vision models. */
  images?: string[];
  /**
   * Context window to ask for.
   *
   * Only meaningful with an image. A flyer is a few thousand tokens on its own
   * and the default 4096 is not enough for one — qwen2.5vl answers a plain
   * "exceeds the available context size" rather than doing anything useful.
   */
  numCtx?: number;
}

/**
 * One free-text answer to a conversation, for the Matrix bot's chat rooms.
 *
 * The same `think: false` as below, for the same reason: a reasoning preamble
 * is not something to post in a room. A larger context than the listing pass
 * asks for, because the upcoming events travel in the system message.
 */
export async function chatText(opts: {
  url: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  numCtx?: number;
}): Promise<string> {
  const res = await withTimeout(opts.timeoutMs, (signal) =>
    fetch(`${base(opts.url)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0.4, num_ctx: opts.numCtx ?? 16384 },
        messages: opts.messages,
      }),
    }).catch((err: Error) => {
      throw new OllamaError(err.name === 'AbortError' ? 'timed out' : `cannot reach ${opts.url}`);
    })
  );
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      /* keep the raw text */
    }
    throw new OllamaError(detail);
  }
  const content = (JSON.parse(text) as { message?: { content?: string } }).message?.content ?? '';
  // A model that thinks anyway puts it in a <think> block; that is not the
  // answer. Some templates open the block in the prompt, so only the close
  // arrives: everything up to the last one is thinking.
  const closed = content.lastIndexOf('</think>');
  const answer = (closed >= 0 ? content.slice(closed + '</think>'.length) : content)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  if (!answer) throw new OllamaError('answered nothing');
  return answer;
}

/**
 * One structured answer from the model.
 *
 * `think: false` matters: the models worth using here — qwen3 among them — emit
 * a reasoning preamble by default, and with a schema attached that either
 * derails the grammar or arrives glued to the front of the JSON. Backends that
 * have no thinking mode ignore the flag.
 */
export async function chatJson(opts: ChatOptions): Promise<unknown> {
  const res = await withTimeout(opts.timeoutMs, (signal) =>
    fetch(`${base(opts.url)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        format: opts.schema,
        keep_alive: `${opts.keepAliveMinutes ?? 10}m`,
        options: { temperature: 0, ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}) },
        messages: [
          { role: 'user', content: opts.prompt, ...(opts.images ? { images: opts.images } : {}) },
        ],
      }),
    }).catch((err: Error) => {
      throw new OllamaError(
        err.name === 'AbortError' ? 'timed out' : `cannot reach ${opts.url}`
      );
    })
  );

  const text = await res.text();
  if (!res.ok) {
    // Ollama puts the useful part in a JSON error field; a missing model is by
    // far the most common, and saying which model is what makes it fixable.
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      /* keep the raw text */
    }
    throw new OllamaError(detail);
  }

  const body = JSON.parse(text) as { message?: { content?: string } };
  const content = body.message?.content;
  // Some vision models answer nothing at all when handed a schema — qwen3-vl
  // does, reliably. Worth naming, because it looks like a timeout otherwise.
  if (!content || !content.trim()) throw new OllamaError('answered nothing');
  try {
    return JSON.parse(content);
  } catch {
    throw new OllamaError(`answer was not JSON: ${content.slice(0, 120)}`);
  }
}

/** Where a service's Ollama is: its own address, else the usual one. */
const addressOf = (s: LlmService): string => ollamaUrl(s.baseUrl);

export const ollamaProvider: Provider = {
  listModels: (s) => listModels(addressOf(s)),
  chatJson: (s, r) =>
    chatJson({
      url: addressOf(s),
      model: s.model,
      prompt: r.prompt,
      schema: r.schema,
      timeoutMs: r.timeoutMs,
      keepAliveMinutes: r.keepAliveMinutes,
      images: r.images,
      numCtx: r.numCtx,
    }),
  chatText: (s, r) =>
    chatText({
      url: addressOf(s),
      model: s.model,
      messages: r.messages,
      timeoutMs: r.timeoutMs,
      numCtx: r.numCtx,
    }),
};
