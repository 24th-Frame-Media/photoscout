import crypto from 'node:crypto';
import { Db } from './db.js';
import { Role, SessionUser, SESSION_DAYS, handleFrom, isAdminAccount } from './auth.js';

/**
 * The half of auth that reaches the database: users and sessions. Kept apart
 * from auth.ts so the pure rules can be tested without opening one.
 */

export interface User {
  id: string;
  username: string;
  avatar: string;
  role: Role;
  banned: boolean;
  created_at: string;
}

const COLS = 'id, username, avatar, role, banned, created_at';
const toUser = (r: any): User => ({ ...r, banned: r.banned === 1 });

export function findUserById(db: Db, id: string): User | undefined {
  const r = db.handle.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id);
  return r ? toUser(r) : undefined;
}

export function usernameTaken(db: Db, username: string): boolean {
  return Boolean(db.handle.prepare('SELECT 1 FROM users WHERE username = ?').get(username));
}

export function listUsers(db: Db): User[] {
  return db.handle.prepare(`SELECT ${COLS} FROM users ORDER BY created_at`).all().map(toUser);
}

/** `provider:id`, which is what goes in ADMIN_IDS. Shown only to the account itself. */
export function accountIdOf(db: Db, id: string): string | undefined {
  const r = db.handle.prepare('SELECT provider, provider_id FROM users WHERE id = ?').get(id) as
    { provider: string; provider_id: string } | undefined;
  return r ? `${r.provider}:${r.provider_id}` : undefined;
}

/**
 * The account a provider's answer belongs to, made on first sign-in.
 *
 * Whether it is an admin is read from ADMIN_IDS each time, and only ever
 * upward: naming an account there promotes it on its next sign-in, and taking
 * it back out is done from the users page, where it is a decision somebody made.
 */
export function upsertOAuthUser(
  db: Db,
  who: { provider: string; providerId: string; name: string; avatar: string },
  adminIds: string | undefined = process.env.ADMIN_IDS
): User {
  const admin = isAdminAccount(who.provider, who.providerId, adminIds);
  const existing = db.handle
    .prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
    .get(who.provider, who.providerId) as { id: string } | undefined;
  if (existing) {
    db.handle.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(who.avatar, existing.id);
    if (admin) db.handle.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    return findUserById(db, existing.id) as User;
  }
  const id = crypto.randomUUID();
  const username = handleFrom(who.name, (h) => usernameTaken(db, h));
  db.handle
    .prepare('INSERT INTO users (id, username, provider, provider_id, avatar, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, who.provider, who.providerId, who.avatar, admin ? 'admin' : 'contributor', new Date().toISOString());
  return findUserById(db, id) as User;
}

export function setUsername(db: Db, id: string, username: string): void {
  db.handle.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
}

export function setUserRole(db: Db, id: string, role: Role): void {
  db.handle.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

/** A banned account keeps its rows and loses its sessions; signing in again gets it nowhere. */
export function setUserBanned(db: Db, id: string, banned: boolean): void {
  db.handle.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id);
  if (banned) deleteUserSessions(db, id);
}

export function deleteUser(db: Db, id: string): void {
  deleteUserSessions(db, id);
  db.handle.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// --- sessions -------------------------------------------------------------

const hashOf = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, userId: string, now = Date.now()): { token: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 3600 * 1000;
  const token = crypto.randomBytes(32).toString('base64url');
  db.handle
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashOf(token), userId, new Date(now).toISOString(), new Date(now + maxAgeMs).toISOString());
  return { token, maxAgeMs };
}

/** Who a cookie belongs to, read fresh each time so a ban or a new role is felt at once. */
export function sessionUser(db: Db, token: string | undefined, now = Date.now()): SessionUser | null {
  if (!token) return null;
  const r = db.handle
    .prepare(
      `SELECT u.id, u.role, u.banned, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(hashOf(token)) as { id: string; role: Role; banned: number; expires_at: string } | undefined;
  if (!r || r.banned === 1 || Date.parse(r.expires_at) <= now) return null;
  return { id: r.id, role: r.role };
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.handle.prepare('DELETE FROM sessions WHERE id = ?').run(hashOf(token));
}

export function deleteUserSessions(db: Db, userId: string): void {
  db.handle.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteExpiredSessions(db: Db, now = Date.now()): void {
  db.handle.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
}
