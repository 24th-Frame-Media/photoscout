/**
 * OpenAI, and any server that speaks its chat API: OpenRouter, LM Studio, vLLM.
 *
 * Reasoning models reject `temperature` and `max_tokens`, so neither is sent.
 */
import { LlmError, type JsonRequest, type LlmService, type Provider, type TextRequest } from '../types.js';
import {
  getOnce,
  httpError,
  isOk,
  isRecord,
  mimeOf,
  parseJsonAnswer,
  parseReply,
  schemaInPrompt,
  sendWithRetries,
  stripThink,
} from '../util.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const LIST_TIMEOUT_MS = 10_000;

/** Dropped everywhere: the callers check ranges themselves, and strict mode refuses them. */
const DROPPED = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
]);
/** Left exactly as written: their contents are values, not schema. */
const OPAQUE = new Set(['enum', 'const', 'default', 'examples', 'required']);

function addNull(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  // An enum is checked as well as the type: without null among its values a
  // nullable field still could never be null.
  const values = Array.isArray(schema.enum) && !schema.enum.includes(null) ? { enum: [...schema.enum, null] } : {};
  const t = schema.type;
  if (typeof t === 'string') return { ...schema, ...values, type: [t, 'null'] };
  if (Array.isArray(t)) return t.includes('null') ? { ...schema, ...values } : { ...schema, ...values, type: [...t, 'null'] };
  return schema;
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROPPED.has(k)) continue;
    if (OPAQUE.has(k)) out[k] = v;
    else if (k === 'properties' && isRecord(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, strictNode(sub)]));
    } else out[k] = strictNode(v);
  }
  if (out.type === 'object' || isRecord(out.properties)) {
    const props = isRecord(out.properties) ? out.properties : {};
    const wasRequired = new Set(Array.isArray(out.required) ? out.required : []);
    // Strict mode wants every property listed as required; one that was
    // optional becomes a nullable instead, so the model may still leave it empty.
    const next: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props)) {
      next[name] = wasRequired.has(name) ? sub : addNull(sub);
    }
    out.properties = next;
    out.required = Object.keys(next);
    out.additionalProperties = false;
  }
  return out;
}

/** A JSON Schema made acceptable to OpenAI's strict structured output. A copy; the input is not changed. */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictNode(schema) as Record<string, unknown>;
}

const baseOf = (s: LlmService): string => (s.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, '');

function headersOf(s: LlmService): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(s.apiKey.trim() ? { Authorization: `Bearer ${s.apiKey}` } : {}),
  };
}

/**
 * The request for one structured answer. `plainJson` is the fallback for a
 * server that rejects the strict schema: it is asked for any JSON object, and
 * the schema is spelled out in the prompt.
 */
export function buildOpenAiJsonRequest(
  s: LlmService,
  r: JsonRequest,
  plainJson = false,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const images = r.images ?? [];
  const prompt = plainJson ? schemaInPrompt(r.prompt, r.schema) : r.prompt;
  const content = images.length
    ? [
        { type: 'text', text: prompt },
        ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:${mimeOf(b)};base64,${b}` } })),
      ]
    : prompt;
  return {
    url: `${baseOf(s)}/chat/completions`,
    headers: headersOf(s),
    body: {
      model: s.model,
      messages: [{ role: 'user', content }],
      response_format: plainJson
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: strictSchema(r.schema) } },
      max_completion_tokens: 16000,
    },
  };
}

interface Message {
  content?: string | null;
  refusal?: string | null;
}

function firstMessage(text: string): Message {
  const body = parseReply<{ choices?: { message?: Message }[] }>(text);
  return body.choices?.[0]?.message ?? {};
}

export const openaiProvider: Provider = {
  async listModels(s) {
    const base = baseOf(s);
    const reply = await getOnce(`${base}/models`, headersOf(s), LIST_TIMEOUT_MS, base);
    if (!isOk(reply)) throw httpError(reply);
    const body = parseReply<{ data?: { id?: unknown }[] }>(reply.text);
    return (body.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [{ name: m.id, size: 0 }] : []));
  },

  async chatJson(s, r: JsonRequest) {
    const deadline = Date.now() + r.timeoutMs;
    const send = (plainJson: boolean) => {
      const q = buildOpenAiJsonRequest(s, r, plainJson);
      return sendWithRetries(q.url, { method: 'POST', headers: q.headers, body: JSON.stringify(q.body) }, deadline, baseOf(s));
    };
    let reply = await send(false);
    // A server without strict schema support says so in the error; then once more, plainly.
    if (reply.status === 400 && /response_format|json_schema/i.test(reply.text)) reply = await send(true);
    if (!isOk(reply)) throw httpError(reply);
    const message = firstMessage(reply.text);
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
      throw new LlmError(`refused: ${message.refusal}`);
    }
    return parseJsonAnswer(message.content ?? '');
  },

  async chatText(s, r: TextRequest) {
    const base = baseOf(s);
    const reply = await sendWithRetries(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: headersOf(s),
        body: JSON.stringify({ model: s.model, messages: r.messages, max_completion_tokens: 4000 }),
      },
      Date.now() + r.timeoutMs,
      base,
    );
    if (!isOk(reply)) throw httpError(reply);
    const text = stripThink(firstMessage(reply.text).content ?? '').trim();
    if (!text) throw new LlmError('answered nothing');
    return text;
  },
};
