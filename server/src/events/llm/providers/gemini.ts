/**
 * Google Gemini, through the Generative Language API.
 *
 * The key travels in a header. A key in the URL would end up in logs and
 * error messages that name the address.
 */
import { LlmError, type JsonRequest, type LlmService, type Provider, type TextRequest } from '../types.js';
import {
  getOnce,
  httpError,
  isOk,
  mimeOf,
  parseJsonAnswer,
  parseReply,
  schemaInPrompt,
  sendWithRetries,
  stripThink,
} from '../util.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LIST_TIMEOUT_MS = 10_000;

const baseOf = (s: LlmService): string => (s.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, '');

function headersOf(s: LlmService): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(s.apiKey.trim() ? { 'x-goog-api-key': s.apiKey } : {}),
  };
}

const generateUrl = (s: LlmService): string => `${baseOf(s)}/models/${encodeURIComponent(s.model)}:generateContent`;

/**
 * The request for one structured answer. `plainJson` is the fallback for a
 * server that rejects the response schema: JSON is asked for, and the schema
 * is spelled out in the prompt.
 */
export function buildGeminiJsonRequest(
  s: LlmService,
  r: JsonRequest,
  plainJson = false,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const images = r.images ?? [];
  const prompt = plainJson ? schemaInPrompt(r.prompt, r.schema) : r.prompt;
  return {
    url: generateUrl(s),
    headers: headersOf(s),
    body: {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            ...images.map((b) => ({ inlineData: { mimeType: mimeOf(b), data: b } })),
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16000,
        responseMimeType: 'application/json',
        ...(plainJson ? {} : { responseJsonSchema: r.schema }),
      },
    },
  };
}

interface GeminiReply {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** The text of the first answer, without the model's own reasoning parts; a blocked answer is an error. */
function answerText(text: string): string {
  const body = parseReply<GeminiReply>(text);
  const candidate = body.candidates?.[0];
  if (!candidate) {
    if (body.promptFeedback?.blockReason) throw new LlmError(`blocked: ${body.promptFeedback.blockReason}`);
    return '';
  }
  if (candidate.finishReason === 'SAFETY') throw new LlmError('blocked: SAFETY');
  return (candidate.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
}

export const geminiProvider: Provider = {
  async listModels(s) {
    const base = baseOf(s);
    const reply = await getOnce(`${base}/models?pageSize=1000`, headersOf(s), LIST_TIMEOUT_MS, base);
    if (!isOk(reply)) throw httpError(reply);
    const body = parseReply<{ models?: { name?: unknown; supportedGenerationMethods?: unknown }[] }>(reply.text);
    return (body.models ?? []).flatMap((m) =>
      typeof m.name === 'string' &&
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes('generateContent')
        ? [{ name: m.name.replace(/^models\//, ''), size: 0 }]
        : []
    );
  },

  async chatJson(s, r: JsonRequest) {
    const deadline = Date.now() + r.timeoutMs;
    const send = (plainJson: boolean) => {
      const q = buildGeminiJsonRequest(s, r, plainJson);
      return sendWithRetries(q.url, { method: 'POST', headers: q.headers, body: JSON.stringify(q.body) }, deadline, baseOf(s));
    };
    let reply = await send(false);
    // A server that rejects the schema says so in the error; then once more, plainly.
    if (reply.status === 400 && /schema/i.test(reply.text)) reply = await send(true);
    if (!isOk(reply)) throw httpError(reply);
    return parseJsonAnswer(answerText(reply.text));
  },

  async chatText(s, r: TextRequest) {
    const system = r.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = r.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const reply = await sendWithRetries(
      generateUrl(s),
      {
        method: 'POST',
        headers: headersOf(s),
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature: 0.4, maxOutputTokens: 4000 },
        }),
      },
      Date.now() + r.timeoutMs,
      baseOf(s),
    );
    if (!isOk(reply)) throw httpError(reply);
    const text = stripThink(answerText(reply.text)).trim();
    if (!text) throw new LlmError('answered nothing');
    return text;
  },
};
