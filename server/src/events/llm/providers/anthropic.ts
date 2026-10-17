/**
 * Claude, through the official SDK.
 *
 * API keys only. A Claude Code or subscription token is not an API key and is
 * not accepted here. The SDK retries rate limits and server errors itself, honouring
 * Retry-After, so nothing here wraps it in another retry loop.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type JsonRequest, type LlmService, type Provider, type TextRequest } from '../types.js';
import { isRecord, mimeOf, parseJsonAnswer } from '../util.js';

const LIST_TIMEOUT_MS = 10_000;
const DROPPED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength']);
const OPAQUE = new Set(['enum', 'const', 'default', 'examples', 'required']);

function claudeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(claudeNode);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROPPED.has(k)) continue;
    if (OPAQUE.has(k)) out[k] = v;
    else if (k === 'properties' && isRecord(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, claudeNode(sub)]));
    } else out[k] = claudeNode(v);
  }
  if (out.type === 'object' || isRecord(out.properties)) out.additionalProperties = false;
  // Nullable as a type list is not something the structured output takes;
  // as a choice between the type and null it is.
  if (Array.isArray(out.type) && out.type.length === 2 && out.type.includes('null')) {
    const base = out.type.find((t) => t !== 'null');
    const { type: _type, ...siblings } = out;
    return { anyOf: [{ ...siblings, type: base }, { type: 'null' }] };
  }
  return out;
}

/** A JSON Schema in the form Claude's structured output takes. A copy; the input is not changed. */
export function claudeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return claudeNode(schema) as Record<string, unknown>;
}

const clients = new Map<string, Anthropic>();

function clientFor(s: LlmService): Anthropic {
  const baseURL = s.baseUrl.trim();
  const key = `${s.apiKey}\n${baseURL}`;
  let client = clients.get(key);
  if (!client) {
    client = new Anthropic({ apiKey: s.apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 2 });
    clients.set(key, client);
  }
  return client;
}

/** The SDK's errors, as this app's: a sentence for the connection, the status for the rest. */
function failure(err: unknown): unknown {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timed out');
  // Checked before APIError: a connection failure is an APIError too, with no status.
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('cannot reach Anthropic');
  if (err instanceof Anthropic.APIError) return new LlmError(`HTTP ${err.status ?? '?'}: ${err.message}`);
  return err;
}

function textOf(blocks: Anthropic.ContentBlock[]): string {
  let out = '';
  for (const block of blocks) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

export const anthropicProvider: Provider = {
  async listModels(s) {
    const out: { name: string; size: number }[] = [];
    try {
      for await (const m of clientFor(s).models.list({}, { timeout: LIST_TIMEOUT_MS })) {
        out.push({ name: m.id, size: 0 });
      }
    } catch (err) {
      throw failure(err);
    }
    return out;
  },

  async chatJson(s, r: JsonRequest) {
    const content: Anthropic.ContentBlockParam[] = [
      ...(r.images ?? []).map((b) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mimeOf(b), data: b },
      })),
      { type: 'text' as const, text: r.prompt },
    ];
    let res: Anthropic.Message;
    try {
      res = await clientFor(s).messages.create(
        {
          model: s.model,
          max_tokens: 16000,
          messages: [{ role: 'user', content }],
          output_config: { format: { type: 'json_schema', schema: claudeSchema(r.schema) } },
        },
        { timeout: r.timeoutMs }
      );
    } catch (err) {
      throw failure(err);
    }
    if (res.stop_reason === 'refusal') throw new LlmError('refused');
    if (res.stop_reason === 'max_tokens') throw new LlmError('answer was cut off');
    return parseJsonAnswer(textOf(res.content));
  },

  async chatText(s, r: TextRequest) {
    const system = r.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = r.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));
    let res: Anthropic.Message;
    try {
      res = await clientFor(s).messages.create(
        {
          model: s.model,
          max_tokens: 4000,
          messages,
          ...(system ? { system } : {}),
        },
        { timeout: r.timeoutMs }
      );
    } catch (err) {
      throw failure(err);
    }
    const text = textOf(res.content).trim();
    if (!text) throw new LlmError('answered nothing');
    return text;
  },
};
