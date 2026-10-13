import { Db } from './db.js';
import { getSettings } from './settings.js';
import { importStaticGtfs, TRAIN_FEEDS } from './feeds/trains.js';

export type ApiKeyProvider = 'tfnsw' | 'openaip';
export const VALID_PROVIDERS: readonly ApiKeyProvider[] = ['tfnsw', 'openaip'] as const;

export function isValidProvider(provider: unknown): provider is ApiKeyProvider {
  return typeof provider === 'string' && VALID_PROVIDERS.includes(provider as ApiKeyProvider);
}

export interface UserApiKeyStatus {
  tfnswKeySet: boolean;
  openaipKeySet: boolean;
}

/** Get a user's API key for a provider. Returns null if not configured. Never expose to client! */
export function getUserApiKey(db: Db, userId: string, provider: ApiKeyProvider): string | null {
  const row = db.handle.prepare('SELECT api_key FROM user_api_keys WHERE user_id = ? AND provider = ?')
    .get(userId, provider) as { api_key: string } | undefined;
  return row ? row.api_key : null;
}

/** What GET /api/user/api-keys returns: boolean flags indicating whether each provider key is configured. */
export function getUserApiKeyStatus(db: Db, userId: string): UserApiKeyStatus {
  const rows = db.handle.prepare('SELECT provider FROM user_api_keys WHERE user_id = ?')
    .all(userId) as { provider: string }[];
  const providers = new Set(rows.map((r) => r.provider));
  const tfnsw = providers.has('tfnsw');
  const openaip = providers.has('openaip');
  return {
    tfnswKeySet: tfnsw,
    openaipKeySet: openaip,
  };
}

export function setUserApiKey(db: Db, userId: string, provider: ApiKeyProvider, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('API key cannot be empty');
  if (trimmed.length > 500) throw new Error('API key is too long (maximum 500 characters)');
  const now = new Date().toISOString();
  db.handle.prepare(
    `INSERT INTO user_api_keys (user_id, provider, api_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       api_key = excluded.api_key,
       updated_at = excluded.updated_at`
  ).run(userId, provider, trimmed, now, now);
}

export function clearUserApiKey(db: Db, userId: string, provider: ApiKeyProvider): void {
  db.handle.prepare('DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
}

/**
 * Trigger background GTFS static timetable imports for the shared cache using the user's key in memory.
 * The key is NOT stored globally.
 */
export function triggerUserGtfsImport(db: Db, apiKey: string): void {
  const settings = getSettings(db);
  const areas = [settings.home, ...settings.areas];
  const noopLog = () => {};
  for (const feed of TRAIN_FEEDS) {
    importStaticGtfs(db, feed, apiKey, areas, noopLog).catch(() => {});
  }
}
