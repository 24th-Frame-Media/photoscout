/**
 * The shapes every model service is spoken to through.
 *
 * A service is one configured place to ask a model something: a local Ollama,
 * an OpenAI-compatible server, Claude or Gemini. The router picks among the
 * services that have a given role, and each provider turns a request into its
 * own wire format. Nothing outside this folder should know which is which.
 */

/** What a service is used for. Text: the listing pass and the importer. Vision: flyers. Chat: the Matrix bot. */
export type LlmRole = 'text' | 'vision' | 'chat';
export const LLM_ROLES: readonly LlmRole[] = ['text', 'vision', 'chat'];

export type ProviderId = 'ollama' | 'openai' | 'anthropic' | 'gemini';
export const PROVIDER_IDS: readonly ProviderId[] = ['ollama', 'openai', 'anthropic', 'gemini'];

/** Which service takes the next request when several can do the same job. */
export type LlmStrategy = 'least_busy' | 'round_robin' | 'random';
export const LLM_STRATEGIES: readonly LlmStrategy[] = ['least_busy', 'round_robin', 'random'];

export interface LlmService {
  id: string;
  label: string;
  provider: ProviderId;
  /** Ollama and OpenAI-compatible servers: the address. Blank means the provider's own. */
  baseUrl: string;
  /** A credential: never sent back. Ollama has none. */
  apiKey: string;
  model: string;
  roles: LlmRole[];
  enabled: boolean;
  /**
   * False asks the model to answer without reasoning first. Only the OpenAI
   * provider acts on it (through `chat_template_kwargs`, which Strata, vLLM and
   * llama.cpp honour); Ollama already never thinks and the others never ask to.
   */
  thinking: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonRequest {
  prompt: string;
  /** JSON Schema the answer must match. */
  schema: Record<string, unknown>;
  /** Base64 JPEG/PNG/WebP data, for the vision models. */
  images?: string[];
  timeoutMs: number;
  /** Ollama only: minutes to keep the model resident between calls. */
  keepAliveMinutes?: number;
  /** Ollama only: the context window to ask for. */
  numCtx?: number;
}

export interface TextRequest {
  messages: ChatMessage[];
  timeoutMs: number;
  /** Ollama only. */
  numCtx?: number;
}

export interface ModelInfo {
  name: string;
  /** Bytes on disk where the service reports it; 0 otherwise. */
  size: number;
}

export interface Provider {
  listModels(s: LlmService): Promise<ModelInfo[]>;
  chatJson(s: LlmService, r: JsonRequest): Promise<unknown>;
  chatText(s: LlmService, r: TextRequest): Promise<string>;
}

/** A service as the status page sees it: how it stands, and never its key. */
export interface LlmServiceStatus {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  roles: LlmRole[];
  enabled: boolean;
  reachable: boolean;
  /** Why not, when unreachable. */
  problem: string;
  models: ModelInfo[];
  /** Whether the service's model is among the ones it reports. */
  modelAvailable: boolean;
}

/** A failure the caller can show. Anything else is a bug. */
export class LlmError extends Error {}
