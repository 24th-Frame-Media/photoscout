import { Db } from './db.js';

/**
 * Whether somebody who has not signed in may read the public map.
 *
 * Off by default: a fresh instance is private, and every route except
 * signing in needs a session (see `needsAuth` in auth.ts). An admin can allow
 * public reads under Settings → Instance.
 *
 * The environment wins over what an admin saved, so an operator can pin the
 * mode without the UI. PUBLIC_READS=1 or true allows public reads. Any other
 * value that is not blank (0, false, or a typo such as "yes") keeps the
 * instance private; blank counts as unset. Failing towards private means a
 * mistyped value can never open an instance up.
 *
 * Kept in its own kv row, like the sign-in keys, so reading it never means
 * parsing the settings and a bad row can only fall back to private.
 */

export type AccessSource = 'env' | 'stored' | 'default';

export interface AccessConfig {
  publicReads: boolean;
  /** Where the answer came from: the environment (locked), an admin's choice, or the private default. */
  source: AccessSource;
}

/** The environment's answer, or null when PUBLIC_READS is unset or blank. */
function fromEnv(): boolean | null {
  const raw = process.env.PUBLIC_READS?.trim().toLowerCase();
  if (!raw) return null;
  return raw === '1' || raw === 'true';
}

/** What an admin saved, or null for nothing usable: no row, bad JSON or a value that is not a boolean. */
function stored(db: Db): boolean | null {
  try {
    const raw = db.getKv('access');
    if (!raw) return null;
    const value = (JSON.parse(raw) as { publicReads?: unknown } | null)?.publicReads;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** What Settings → Instance shows an admin. */
export function accessConfigView(db: Db): AccessConfig {
  const env = fromEnv();
  if (env !== null) return { publicReads: env, source: 'env' };
  const saved = stored(db);
  if (saved !== null) return { publicReads: saved, source: 'stored' };
  return { publicReads: false, source: 'default' };
}

/** Whether public reads are on right now. Read for every request, so it is a single indexed lookup. */
export function publicReads(db: Db): boolean {
  return accessConfigView(db).publicReads;
}

/** Save an admin's choice. The environment still wins if it sets PUBLIC_READS; the route refuses a save in that case. */
export function setPublicReads(db: Db, value: boolean): void {
  db.setKv('access', JSON.stringify({ publicReads: value }));
}
