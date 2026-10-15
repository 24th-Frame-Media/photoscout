import { LlmError } from './types.js';

/**
 * Helpers shared by the providers: image types, answer parsing, and the retry
 * loop the hosted APIs need. Nothing here knows which service it is talking to.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The picture type of a base64 image, from the first characters every encoding of that type starts with. */
export function mimeOf(b64: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  // '/9j/' is JPEG, and anything else is sent as JPEG too.
  return 'image/jpeg';
}

/**
 * A model that thinks anyway puts it in a <think> block; that is not the
 * answer. Some templates open the block in the prompt, so only the close
 * arrives: everything up to the last one is thinking.
 */
export function stripThink(content: string): string {
  const closed = content.lastIndexOf('</think>');
  return (closed >= 0 ? content.slice(closed + '</think>'.length) : content).replace(/<think>[\s\S]*?<\/think>/g, '');
}

/** One structured answer as an object: a ```json fence is allowed round it. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new LlmError('answered nothing');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new LlmError(`answer was not JSON: ${trimmed.slice(0, 120)}`);
  }
}

/** For services that cannot be told to follow a schema: the schema goes in the prompt instead. */
export function schemaInPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
}

/** A response body parsed, or a clear failure rather than a SyntaxError. */
export function parseReply<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`unreadable reply: ${text.slice(0, 120)}`);
  }
}

/** The useful part of an error body: a JSON `error` string, or its `error.message`, else the start of the text. */
export function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (parsed.error && typeof parsed.error === 'object') {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
  } catch {
    /* not JSON: keep the raw text */
  }
  return text.slice(0, 200);
}

export interface Reply {
  status: number;
  text: string;
  retryAfter: string | null;
}

export function isOk(reply: Reply): boolean {
  return reply.status >= 200 && reply.status < 300;
}

export function httpError(reply: Reply): LlmError {
  return new LlmError(`HTTP ${reply.status}: ${errorDetail(reply.text)}`);
}

/** Statuses worth another go: a timeout, a rate limit or overload, a server that fell over. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Rate limits and overloads wait their turn and do not use up one of the attempts. */
const RATE_LIMITED = new Set([429, 529]);
const MAX_FAILURES = 3;
const MAX_BACKOFF_S = 60;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After as seconds, or as an HTTP date; null when it is neither. */
function parseRetryAfter(value: string): number | null {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, (when - Date.now()) / 1000) : null;
}

async function backoff(retryAfter: string | null, tries: number, deadlineMs: number): Promise<void> {
  const fromHeader = retryAfter === null ? null : parseRetryAfter(retryAfter);
  const seconds = fromHeader ?? Math.min(MAX_BACKOFF_S, 2 ** tries + Math.random());
  const waitMs = seconds * 1000;
  // Never sleep past the time the whole call was given.
  if (Date.now() + waitMs > deadlineMs) throw new LlmError('timed out');
  await pause(waitMs);
}

/**
 * One request, retried on the statuses in RETRY_STATUS and on network errors.
 *
 * The attempt receives the signal that fires at the deadline, so a slow body is
 * cut off too. A retryable status that runs out of attempts is returned rather
 * than thrown, so the caller reports the status it actually got.
 */
export async function fetchWithRetries(
  attempt: (signal: AbortSignal) => Promise<Reply>,
  deadlineMs: number,
  what: string,
): Promise<Reply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadlineMs - Date.now()));
  let counted = 0;
  let tries = 0;
  try {
    for (;;) {
      tries++;
      let reply: Reply;
      try {
        reply = await attempt(ctrl.signal);
      } catch {
        if (ctrl.signal.aborted) throw new LlmError('timed out');
        counted++;
        if (counted >= MAX_FAILURES) throw new LlmError(`cannot reach ${what}`);
        await backoff(null, tries, deadlineMs);
        continue;
      }
      if (!RETRY_STATUS.has(reply.status)) return reply;
      if (!RATE_LIMITED.has(reply.status)) counted++;
      if (counted >= MAX_FAILURES) return reply;
      await backoff(reply.retryAfter, tries, deadlineMs);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A POST (or GET) that retries as above, with the deadline `deadlineMs` as an absolute time. */
export function sendWithRetries(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  deadlineMs: number,
  what: string,
): Promise<Reply> {
  return fetchWithRetries(
    async (signal) => {
      const res = await fetch(url, { ...init, signal });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') };
    },
    deadlineMs,
    what,
  );
}

/** A single GET with no retries, for listing models. */
export async function getOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  what: string,
): Promise<Reply> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { headers, signal });
    return { status: res.status, text: await res.text(), retryAfter: null };
  } catch {
    throw signal.aborted ? new LlmError('timed out') : new LlmError(`cannot reach ${what}`);
  }
}
