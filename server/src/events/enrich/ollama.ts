/**
 * Kept so that imports from this path still resolve. The Ollama code lives in
 * llm/providers/ollama.ts now, and the callers ask llm/router.ts for answers.
 */
export { chatJson, chatText, listModels, OllamaError } from '../llm/providers/ollama.js';
export type { ChatOptions, OllamaModel } from '../llm/providers/ollama.js';
export type { ChatMessage } from '../llm/types.js';
