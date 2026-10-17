import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGeminiJsonRequest, geminiProvider } from '../../src/events/llm/providers/gemini.js';
import { buildOpenAiJsonRequest, openaiProvider, strictSchema } from '../../src/events/llm/providers/openai.js';
import { claudeSchema } from '../../src/events/llm/providers/anthropic.js';
import {
  checkRole,
  chatText,
  listRoleModels,
  poolKey,
  setProvidersForTest,
} from '../../src/events/llm/router.js';
import { legacyServices, normalizeService, servicesFor } from '../../src/events/llm/services.js';
import { LlmError, type JsonRequest, type LlmService, type Provider } from '../../src/events/llm/types.js';
import { mimeOf, parseJsonAnswer, stripThink } from '../../src/events/llm/util.js';
import { mergeSecrets, redactSettings } from '../../src/events/secrets.js';
import { crawlerModel } from '../../src/events/sources/crawler.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/events/sources/types.js';

const PERSON = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0, maximum: 120 },
    nickname: { type: 'string', pattern: '^[a-z]+$' },
    tags: { type: 'array', items: { type: 'string', maxLength: 10 } },
    home: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  required: ['name', 'age', 'home'],
};

const REQ = { messages: [{ role: 'user' as const, content: 'hi' }], timeoutMs: 5000 };

const svc = (id: string, over: Partial<LlmService> = {}): LlmService => ({
  id,
  label: id.toUpperCase(),
  provider: 'ollama',
  baseUrl: 'http://ollama.test:11434',
  apiKey: '',
  model: `${id}-model`,
  roles: ['text', 'chat'],
  enabled: true,
  ...over,
});

const settingsWith = (services: LlmService[], extra: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  llmServices: services,
  ...extra,
});

/** A provider that answers every call with `answer`, and records which service asked. */
function recordingProvider(calls: string[], answer: (s: LlmService) => Promise<string> | string = () => 'ok'): Provider {
  return {
    listModels: async (s) => [{ name: s.model, size: 0 }],
    chatJson: async (s) => {
      calls.push(s.id);
      return {};
    },
    chatText: async (s) => {
      calls.push(s.id);
      return answer(s);
    },
  };
}

const quiet: Provider = {
  listModels: async () => [],
  chatJson: async () => ({}),
  chatText: async () => '',
};

// --- schemas ---------------------------------------------------------------

test('strict schema: every property required, optional ones nullable, no open objects', () => {
  const s = strictSchema(PERSON) as Record<string, any>;
  assert.deepEqual(s.required, ['name', 'age', 'nickname', 'tags', 'home']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.nickname.type, ['string', 'null']);
  assert.deepEqual(s.properties.tags.type, ['array', 'null']);
  assert.equal(s.properties.name.type, 'string', 'a required property is not made nullable');
  assert.equal(s.properties.home.additionalProperties, false);
  assert.deepEqual(s.properties.home.required, ['city']);
});

test('strict schema drops the range and length keywords, and leaves the input alone', () => {
  const s = strictSchema(PERSON) as Record<string, any>;
  assert.equal('minimum' in s.properties.age, false);
  assert.equal('maximum' in s.properties.age, false);
  assert.equal('minLength' in s.properties.name, false);
  assert.equal('pattern' in s.properties.nickname, false);
  assert.equal('maxLength' in s.properties.tags.items, false);
  assert.equal((PERSON.properties.age as { minimum: number }).minimum, 0, 'the caller’s schema is not changed');
});

test('strict schema: a nullable enum also lists null among its values', () => {
  const s = strictSchema({
    type: 'object',
    properties: { kind: { type: 'string', enum: ['a', 'b'] }, size: { type: ['string', 'null'], enum: ['s', 'm'] } },
    required: [],
  }) as Record<string, any>;
  assert.deepEqual(s.properties.kind.enum, ['a', 'b', null]);
  assert.deepEqual(s.properties.size.enum, ['s', 'm', null]);
});

test('claude schema: a nullable type becomes a choice with null, and objects are closed', () => {
  const s = claudeSchema({
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['music', 'art'] },
      price: { type: ['number', 'null'], minimum: 0 },
      venue: { type: ['string', 'null'], enum: ['A', 'B'], description: 'where' },
      address: { type: 'object', properties: { street: { type: 'string' } } },
    },
    required: ['category'],
  }) as Record<string, any>;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['category'], 'required is kept as given');
  assert.deepEqual(s.properties.price, { anyOf: [{ type: 'number' }, { type: 'null' }] });
  assert.deepEqual(s.properties.venue, {
    anyOf: [{ type: 'string', enum: ['A', 'B'], description: 'where' }, { type: 'null' }],
  });
  assert.equal(s.properties.address.additionalProperties, false);
  assert.deepEqual(s.properties.category, { type: 'string', enum: ['music', 'art'] });
});

// --- request shapes --------------------------------------------------------

const openai: LlmService = svc('o', { provider: 'openai', baseUrl: '', apiKey: 'sk-test', model: 'gpt-test', roles: ['text'] });

test('openai request: strict schema, no temperature or max_tokens, key in the header', () => {
  const q = buildOpenAiJsonRequest(openai, { prompt: 'Read this', schema: PERSON, timeoutMs: 1000, images: ['iVBORw0KGgo='] });
  assert.equal(q.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(q.headers.Authorization, 'Bearer sk-test');
  assert.equal('temperature' in q.body, false);
  assert.equal('max_tokens' in q.body, false);
  assert.equal(q.body.max_completion_tokens, 16000);
  const format = q.body.response_format as { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } };
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  assert.equal(format.json_schema.schema.additionalProperties, false);
  const content = (q.body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].image_url?.url, 'data:image/png;base64,iVBORw0KGgo=');
});

test('openai request: no Authorization header without a key, and a compatible server’s address is used as given', () => {
  const q = buildOpenAiJsonRequest(
    { ...openai, apiKey: '', baseUrl: 'http://lmstudio.test:1234/v1/' },
    { prompt: 'p', schema: PERSON, timeoutMs: 1000 },
  );
  assert.equal(q.url, 'http://lmstudio.test:1234/v1/chat/completions');
  assert.equal('Authorization' in q.headers, false);
  assert.equal((q.body.messages as { content: unknown }[])[0].content, 'p', 'text only: the prompt as it is');
});

const gemini: LlmService = svc('g', { provider: 'gemini', baseUrl: '', apiKey: 'AIza-secret', model: 'gemini-test', roles: ['vision'] });

test('gemini request: the key travels in a header, never in the address', () => {
  const q = buildGeminiJsonRequest(gemini, { prompt: 'Read', schema: PERSON, timeoutMs: 1000, images: ['/9j/AAAA'] });
  assert.equal(q.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(q.headers['x-goog-api-key'], 'AIza-secret');
  assert.equal(q.url.includes('AIza'), false);
  const config = q.body.generationConfig as Record<string, unknown>;
  assert.equal(config.temperature, 0);
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseJsonSchema, PERSON);
  const parts = (q.body.contents as { parts: { inlineData?: { mimeType: string } }[] }[])[0].parts;
  assert.equal(parts[1].inlineData?.mimeType, 'image/jpeg');
});

test('image types are read from the start of the base64', () => {
  assert.equal(mimeOf('/9j/4AAQSkZJRg'), 'image/jpeg');
  assert.equal(mimeOf('iVBORw0KGgo'), 'image/png');
  assert.equal(mimeOf('UklGRiQAAABXRUJQ'), 'image/webp');
  assert.equal(mimeOf('AAAA'), 'image/jpeg');
});

test('an answer inside a json fence is read; prose and nothing are refused', () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('  {"a": 2}  '), { a: 2 });
  assert.throws(() => parseJsonAnswer('   '), (err: unknown) => err instanceof LlmError && err.message === 'answered nothing');
  assert.throws(() => parseJsonAnswer('Sure, here it is'), /answer was not JSON: Sure, here it is/);
});

test('reasoning is stripped from a free-text answer', () => {
  assert.equal(stripThink('<think>hmm</think>the answer'), 'the answer');
  assert.equal(stripThink('leftover thinking</think>the answer'), 'the answer');
});

// --- the providers, with fetch stubbed ------------------------------------

test('a 503 is retried, and the answer comes from the second try', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    return calls === 1
      ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  });
  const out = await openaiProvider.chatJson(openai, { prompt: 'p', schema: PERSON, timeoutMs: 10_000 });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});

test('a bad request is reported at once, in the server’s own words', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
  });
  await assert.rejects(
    openaiProvider.chatJson(openai, { prompt: 'p', schema: PERSON, timeoutMs: 10_000 }),
    (err: unknown) => err instanceof LlmError && err.message === 'HTTP 404: model not found',
  );
  assert.equal(calls, 1);
});

test('a retry that would wait past the time given is not made', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response('busy', { status: 503, headers: { 'retry-after': '120' } })
  );
  await assert.rejects(
    openaiProvider.chatJson(openai, { prompt: 'p', schema: PERSON, timeoutMs: 1000 }),
    (err: unknown) => err instanceof LlmError && err.message === 'timed out',
  );
});

test('a server that refuses strict schemas is asked for plain JSON, with the schema in the prompt', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return bodies.length === 1
      ? new Response(JSON.stringify({ error: { message: 'response_format json_schema is not supported' } }), { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"x"}' } }] }), { status: 200 });
  });
  const out = await openaiProvider.chatJson(openai, { prompt: 'Who?', schema: PERSON, timeoutMs: 10_000 });
  assert.deepEqual(out, { name: 'x' });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].response_format, { type: 'json_object' });
  assert.match(
    JSON.stringify(bodies[1].messages),
    /Reply with only a JSON object matching this JSON Schema/,
  );
});

test('a refusal from the model is reported as one', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'not this one' } }] }), { status: 200 })
  );
  await assert.rejects(
    openaiProvider.chatJson(openai, { prompt: 'p', schema: PERSON, timeoutMs: 10_000 }),
    (err: unknown) => err instanceof LlmError && err.message === 'refused: not this one',
  );
});

test('gemini: a schema the server refuses is sent again as plain JSON', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return bodies.length === 1
      ? new Response(JSON.stringify({ error: { message: 'Unknown name "responseJsonSchema"' } }), { status: 400 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"name":"y"}' }] } }] }), { status: 200 });
  });
  const out = await geminiProvider.chatJson(gemini, { prompt: 'Who?', schema: PERSON, timeoutMs: 10_000 });
  assert.deepEqual(out, { name: 'y' });
  const second = bodies[1].generationConfig as Record<string, unknown>;
  assert.equal('responseJsonSchema' in second, false);
  assert.equal(second.responseMimeType, 'application/json');
});

test('openai free text: no temperature is sent, and the reasoning is dropped', async (t) => {
  let sent: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>Hello there' } }] }), { status: 200 });
  });
  const out = await openaiProvider.chatText(openai, { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 10_000 });
  assert.equal(out, 'Hello there');
  assert.equal('temperature' in sent, false);
  assert.equal(sent.max_completion_tokens, 4000);
});

// --- the router ------------------------------------------------------------

test('least busy: a service already in the middle of a call is passed over', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const calls: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  t.after(setProvidersForTest({
    ollama: recordingProvider(calls, async (s) => {
      if (s.id === 'a') await hold;
      return 'ok';
    }),
  }));
  const settings = settingsWith([svc('a'), svc('b')], { llmStrategy: 'least_busy' });
  const first = chatText('chat', REQ, {}, settings);
  await chatText('chat', REQ, {}, settings);
  release();
  await first;
  assert.deepEqual(calls, ['a', 'b']);
});

test('take turns: each call goes to the next service in the list, and the cycle repeats', async (t) => {
  const calls: string[] = [];
  t.after(setProvidersForTest({ ollama: recordingProvider(calls) }));
  const settings = settingsWith([svc('a'), svc('b'), svc('c')], { llmStrategy: 'round_robin' });
  for (let i = 0; i < 6; i++) await chatText('chat', REQ, {}, settings);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls.slice(0, 3)).size, 3, 'each service once per cycle');
  for (let i = 3; i < 6; i++) assert.equal(calls[i], calls[i - 3]);
});

test('a service that fails hands the request to the next one', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const calls: string[] = [];
  t.after(setProvidersForTest({
    ollama: recordingProvider(calls, (s) => {
      if (s.id === 'a') throw new LlmError('cannot reach a');
      return `from ${s.id}`;
    }),
  }));
  const out = await chatText('chat', REQ, {}, settingsWith([svc('a'), svc('b')], { llmStrategy: 'least_busy' }));
  assert.equal(out, 'from b');
  assert.deepEqual(calls, ['a', 'b']);
});

test('when every service fails, the last one tried is named in the error', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  t.after(setProvidersForTest({ ollama: recordingProvider([], () => { throw new LlmError('boom'); }) }));
  await assert.rejects(
    chatText('chat', REQ, {}, settingsWith([svc('a'), svc('b')], { llmStrategy: 'least_busy' })),
    (err: unknown) => err instanceof LlmError && err.message === 'B: boom',
  );
});

test('a lone service reports its own error unchanged, with no name in front', async (t) => {
  t.after(setProvidersForTest({ ollama: recordingProvider([], () => { throw new LlmError('cannot reach http://x'); }) }));
  await assert.rejects(
    chatText('chat', REQ, {}, settingsWith([svc('a')])),
    (err: unknown) => err instanceof LlmError && err.message === 'cannot reach http://x',
  );
});

test('a cancelled call is not sent on to another service', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const calls: string[] = [];
  t.after(setProvidersForTest({
    ollama: recordingProvider(calls, (s) => {
      if (s.id === 'a') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return 'from b';
    }),
  }));
  await assert.rejects(
    chatText('chat', REQ, {}, settingsWith([svc('a'), svc('b')], { llmStrategy: 'least_busy' })),
    (err: unknown) => (err as Error).name === 'AbortError',
  );
  assert.deepEqual(calls, ['a']);
});

test('a chat model named by the room replaces the model of the service that answers', async (t) => {
  const seen: string[] = [];
  t.after(setProvidersForTest({
    ollama: { ...quiet, chatText: async (s) => { seen.push(s.model); return 'ok'; } },
  }));
  await chatText('chat', REQ, { model: 'gemma-test' }, settingsWith([svc('a')]));
  assert.deepEqual(seen, ['gemma-test']);
});

test('a chat model named by the room works on an install with no listing model either', async (t) => {
  const seen: string[] = [];
  t.after(setProvidersForTest({
    ollama: { ...quiet, chatText: async (s) => { seen.push(`${s.id}:${s.model}`); return 'ok'; } },
  }));
  const settings = { ...DEFAULT_SETTINGS, llmUrl: 'http://ollama.test:11434', llmModel: '' };
  await chatText('chat', REQ, { model: 'gemma-test' }, settings);
  assert.deepEqual(seen, ['legacy-text:gemma-test']);
});

test('a service with no key cannot be ready, and one that answers is enough', async (t) => {
  t.after(setProvidersForTest({ openai: { ...quiet, listModels: async () => [{ name: 'gpt-test', size: 0 }] } }));
  const hosted = svc('h', { provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-test' });
  assert.deepEqual(await checkRole('text', settingsWith([hosted])), { ok: false, message: 'No API key set' });
  const keyed = await checkRole('text', settingsWith([{ ...hosted, apiKey: 'sk-test' }]));
  assert.deepEqual(keyed, { ok: true, message: '' });
});

test('a single Ollama is ready only when its model is installed', async (t) => {
  t.after(setProvidersForTest({ ollama: { ...quiet, listModels: async () => [{ name: 'qwen3:8b', size: 0 }] } }));
  assert.deepEqual(await checkRole('text', settingsWith([svc('a', { model: 'qwen3:8b' })])), { ok: true, message: '' });
  assert.deepEqual(await checkRole('text', settingsWith([svc('a', { model: 'llama3:8b' })])), {
    ok: false,
    message: 'llama3:8b is not installed on http://ollama.test:11434 — try: ollama pull llama3:8b',
  });
  assert.deepEqual(await checkRole('text', settingsWith([])), { ok: false, message: 'No model chosen in Settings' });
});

test('of several services, one answering is enough, and each failure is named', async (t) => {
  t.after(setProvidersForTest({
    ollama: {
      ...quiet,
      listModels: async (s) => {
        if (s.id.startsWith('down')) throw new LlmError(`Cannot reach ${s.baseUrl}`);
        return [{ name: s.model, size: 0 }];
      },
    },
  }));
  assert.deepEqual(await checkRole('text', settingsWith([svc('up'), svc('down1')])), { ok: true, message: '' });
  assert.deepEqual(
    await checkRole('text', settingsWith([svc('down1', { label: 'Garage' }), svc('down2', { label: 'Shed' })])),
    { ok: false, message: 'Garage: Cannot reach http://ollama.test:11434; Shed: Cannot reach http://ollama.test:11434' },
  );
});

test('the models of every chat service are listed once each', async (t) => {
  t.after(setProvidersForTest({
    ollama: {
      ...quiet,
      listModels: async (s) => (s.id === 'a'
        ? [{ name: 'm1', size: 0 }, { name: 'm2', size: 0 }]
        : [{ name: 'm2', size: 0 }, { name: 'm3', size: 0 }]),
    },
  }));
  assert.deepEqual(await listRoleModels('chat', settingsWith([svc('a'), svc('b')])), ['m1', 'm2', 'm3']);
});

// --- services and pools ----------------------------------------------------

test('an install with no services is read as one Ollama for listings and chat, and one for flyers', () => {
  const settings = { ...DEFAULT_SETTINGS, llmUrl: 'http://ollama.lan:11434', llmModel: 'qwen3:8b', visionModel: 'qwen2.5vl' };
  assert.deepEqual(
    servicesFor('text', settings).map((s) => [s.id, s.provider, s.baseUrl, s.model]),
    [['legacy-text', 'ollama', 'http://ollama.lan:11434', 'qwen3:8b']],
  );
  assert.deepEqual(servicesFor('chat', settings).map((s) => s.id), ['legacy-text']);
  assert.deepEqual(servicesFor('vision', settings).map((s) => [s.id, s.model]), [['legacy-vision', 'qwen2.5vl']]);
  assert.equal(servicesFor('text', { ...settings, llmModel: '' }).length, 0, 'no model chosen, nothing offered');
  assert.equal(legacyServices(settings).length, 2);
});

test('a service that is switched off, or has no model, is not offered for a job', () => {
  const settings = settingsWith([
    svc('off', { enabled: false }),
    svc('nomodel', { model: '' }),
    svc('vision-only', { roles: ['vision'] }),
    svc('ok'),
  ]);
  assert.deepEqual(servicesFor('text', settings).map((s) => s.id), ['ok']);
  assert.deepEqual(servicesFor('vision', settings).map((s) => s.id), ['vision-only']);
});

test('one Ollama keeps the bare model name that the caches were keyed by', () => {
  const settings = { ...DEFAULT_SETTINGS, llmUrl: 'http://ollama.lan:11434', llmModel: 'qwen3:8b' };
  assert.equal(poolKey('text', settings), 'qwen3:8b');
  assert.equal(poolKey('vision', settings), '', 'nothing chosen for flyers');
});

test('a pool of several is keyed by all of them, sorted, with a provider on the hosted ones', () => {
  const settings = settingsWith([
    svc('a', { model: 'm1' }),
    svc('b', { provider: 'openai', model: 'gpt-4o', apiKey: 'k' }),
    svc('c', { model: 'm0', roles: ['text'] }),
  ]);
  assert.equal(poolKey('text', settings), 'm0+m1+openai:gpt-4o');
  assert.equal(poolKey('chat', settings), 'm1+openai:gpt-4o', 'the chat pool leaves out the text-only service');
});

test('a service is normalised whatever arrived', () => {
  const s = normalizeService({ provider: 'mistral', roles: ['chat', 'bogus', 'chat', 'text'], enabled: 'yes', label: '  ', model: ' m ' });
  assert.equal(s.provider, 'ollama', 'an unknown provider falls back to Ollama');
  assert.deepEqual(s.roles, ['text', 'chat'], 'roles in order, each once, nothing that is not a role');
  assert.equal(s.enabled, true);
  assert.equal(s.label, 'Ollama', 'a blank label takes the provider’s name');
  assert.equal(s.model, 'm');
  assert.ok(s.id.length > 0, 'an id is made when none was given');
  assert.equal(normalizeService({ id: 'keep-me' }).id, 'keep-me');
});

// --- keys on the way out and back in --------------------------------------

test('a model service key is never sent back, and the page is told only whether one is stored', () => {
  const stored = settingsWith([
    svc('a', { provider: 'openai', apiKey: 'sk-real-key' }),
    svc('b', { provider: 'gemini', apiKey: '' }),
  ]);
  const sent = redactSettings(stored);
  assert.equal(sent.llmServices[0].apiKey, '');
  assert.equal(sent.llmServices[0].apiKeySet, true);
  assert.equal(sent.llmServices[1].apiKeySet, false);
  assert.equal(JSON.stringify(sent).includes('sk-real-key'), false);
});

test('a round trip through the page keeps every service key', () => {
  const stored = settingsWith([svc('a', { provider: 'openai', apiKey: 'sk-real-key' })]);
  const sent = redactSettings(stored);
  const merged = mergeSecrets(stored, JSON.parse(JSON.stringify(sent)) as Record<string, unknown>);
  assert.equal(merged.llmServices?.[0].apiKey, 'sk-real-key');
  assert.equal('apiKeySet' in (merged.llmServices?.[0] ?? {}), false, 'the page’s own flag is not stored');
});

test('a blank service key keeps the stored one, null clears it, and a new one replaces it', () => {
  const stored = settingsWith([
    svc('a', { provider: 'openai', apiKey: 'sk-kept' }),
    svc('b', { provider: 'anthropic', apiKey: 'sk-cleared' }),
    svc('c', { provider: 'gemini', apiKey: 'old' }),
  ]);
  const incoming = (id: string, apiKey: unknown) => ({
    id, label: id, provider: 'openai', baseUrl: '', model: 'm', roles: ['text'], enabled: true, apiKey, apiKeySet: true,
  });
  const merged = mergeSecrets(stored, {
    llmServices: [incoming('a', ''), incoming('b', null), incoming('c', '  fresh  ')],
  });
  const out = merged.llmServices ?? [];
  assert.deepEqual(out.map((s) => s.apiKey), ['sk-kept', '', 'fresh']);
  assert.equal(out[0].provider, 'openai', 'the incoming fields are normalised');
});

test('the crawler is told about an Ollama only when listings may use one', () => {
  const on = { ...DEFAULT_SETTINGS, llmEnabled: true };
  // Off: the model name goes as it always did, and no address.
  assert.deepEqual(crawlerModel({ ...on, llmEnabled: false, llmModel: 'qwen3:8b' }), { ollamaUrl: undefined, llmModel: 'qwen3:8b' });
  // On, with an Ollama for listings: its address and model.
  assert.deepEqual(
    crawlerModel(settingsWith([svc('a', { baseUrl: 'http://ollama.lan:11434', model: 'qwen3:8b' })], { llmEnabled: true })),
    { ollamaUrl: 'http://ollama.lan:11434', llmModel: 'qwen3:8b' },
  );
  // On, with only hosted services: nothing for the crawler, sent blank so a stale one is cleared.
  assert.deepEqual(
    crawlerModel(settingsWith([svc('h', { provider: 'openai', apiKey: 'k' })], { llmEnabled: true })),
    { ollamaUrl: '', llmModel: '' },
  );
});
