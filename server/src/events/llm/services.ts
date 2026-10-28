import crypto from 'node:crypto';
import type { Settings } from '../sources/types.js';
import { isRecord } from './util.js';
import {
  LLM_ROLES,
  PROVIDER_IDS,
  type LlmRole,
  type LlmService,
  type ProviderId,
} from './types.js';

/**
 * The configured services, and which of them a job may use.
 *
 * Pure: everything here is handed its settings, so it can be tested without a
 * database. Settings written before services existed have none, and are read as
 * one Ollama for listings and chat and one for flyers — exactly what they did
 * before, so nothing changes for them until a service is added.
 */

/** Where Ollama is. The setting wins, then `OLLAMA_URL`, then the ordinary local install. */
export function ollamaUrl(configured: string | undefined): string {
  return (configured || '').trim() || process.env.OLLAMA_URL || 'http://localhost:11434';
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * A service as stored: every field filled and bounded, whatever arrived.
 *
 * The same job normalizeTarget does for notification targets. A blank label
 * takes the provider's name, and a missing id is made here, so it survives
 * the next save.
 */
export function normalizeService(raw: unknown): LlmService {
  const o = isRecord(raw) ? raw : {};
  const provider = PROVIDER_IDS.find((p) => p === o.provider) ?? 'ollama';
  const given = Array.isArray(o.roles) ? o.roles : [];
  // In the canonical order, each once, and nothing that is not a role.
  const roles = LLM_ROLES.filter((r) => given.includes(r));
  return {
    id: text(o.id, 40) || crypto.randomUUID(),
    label: text(o.label, 80) || PROVIDER_LABEL[provider],
    provider,
    baseUrl: text(o.baseUrl, 500),
    apiKey: text(o.apiKey, 500),
    model: text(o.model, 200),
    roles,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    thinking: typeof o.thinking === 'boolean' ? o.thinking : true,
  };
}

/**
 * The two services an install without any configured get: one Ollama for the
 * listing pass and the chat bot, one for flyers. Built fresh each call, so a
 * change to the legacy fields is seen at once.
 */
export function legacyServices(settings: Settings): LlmService[] {
  const url = ollamaUrl(settings.llmUrl);
  return [
    {
      id: 'legacy-text',
      label: 'Ollama',
      provider: 'ollama',
      baseUrl: url,
      apiKey: '',
      model: settings.llmModel ?? '',
      roles: ['text', 'chat'],
      enabled: true,
      thinking: true,
    },
    {
      id: 'legacy-vision',
      label: 'Ollama (vision)',
      provider: 'ollama',
      baseUrl: url,
      apiKey: '',
      model: settings.visionModel ?? '',
      roles: ['vision'],
      enabled: true,
      thinking: true,
    },
  ];
}

/** Every service in use: the configured ones, or the legacy pair when none are configured. */
export function allServices(settings: Settings): LlmService[] {
  const configured = settings.llmServices ?? [];
  return configured.length > 0 ? configured : legacyServices(settings);
}

/** Enabled services with the role, whether or not they have a model yet. */
export function candidatesFor(role: LlmRole, settings: Settings): LlmService[] {
  return allServices(settings).filter((s) => s.enabled && s.roles.includes(role));
}

/** The services a job can actually be sent to: enabled, with the role, and a model chosen. */
export function servicesFor(role: LlmRole, settings: Settings): LlmService[] {
  return candidatesFor(role, settings).filter((s) => s.model.trim() !== '');
}
