import crypto from 'node:crypto';

/**
 * Who may do what, kept pure so it can be tested without a database.
 *
 * There are no passwords here. An account is whoever a sign-in provider says
 * it is (see oauth.ts), and a session is a random value in a cookie whose
 * hash is a row in the database (see authStore.ts).
 */

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, has no
 * Domain and has Path=/ — so a sibling subdomain cannot set or shadow it.
 */
export const SESSION_COOKIE = '__Host-ps_session';
/** State and PKCE verifier for a sign-in that is under way. Ten minutes. */
export const OAUTH_COOKIE = '__Host-ps_oauth';

export type Role = 'admin' | 'contributor';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface SessionUser {
  id: string;
  role: Role;
}

/** Signing in and out cannot themselves require a session. */
const OPEN_ROUTES = [
  /^\/api\/auth\/status$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/[a-z]+\/(start|callback)$/,
  /^\/api\/version$/,
  // A share token is itself the credential; `/api/shares` (plural, managing
  // your own links) is a different, protected route.
  /^\/api\/share\//,
];

/**
 * What a visitor who has not signed in may read: the public map and nothing
 * that costs anything. Each of these filters its rows through `canRead`, so
 * an anonymous request sees public rows only. Everything that proxies a
 * third-party service is left off on purpose — an open proxy is an invitation.
 */
const ANONYMOUS_READS = [
  /^\/api\/(places|spots|routes)(\/[^/]+)?$/,
  /^\/api\/spots\/[^/]+\/photos$/,
  /^\/api\/photos\/[^/]+\/(file|thumb)$/,
  // Where the map opens. A visitor gets the same cut-down answer a member does.
  /^\/api\/settings$/,
  // Map layers with no parameters, answered from this server's own cache:
  // a visitor asking costs nobody upstream anything.
  /^\/api\/(rail|fires|aurora)$/,
];

export function normalizePath(p: string): string {
  const withoutQuery = p.split('?')[0].toLowerCase();
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Whether a request needs a signed-in session at all. */
export function needsAuth(method: string, path: string): boolean {
  const normalized = normalizePath(path);
  if (OPEN_ROUTES.some((re) => re.test(normalized))) return false;
  if (method === 'GET' || method === 'HEAD') return !ANONYMOUS_READS.some((re) => re.test(normalized));
  return true;
}

/**
 * Whether a state-changing request came from this site's own pages.
 *
 * SameSite=Lax on the session cookie already keeps it off cross-site POSTs;
 * this is the second lock. A browser sends Origin on every cross-origin
 * request that can change anything, so one that is present and is not ours is
 * refused. A request with no Origin at all is not a browser's cross-site
 * request and carries no ambient cookie worth protecting.
 */
export function originAllowed(method: string, origin: string | undefined, ownOrigin: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (!origin) return true;
  return origin === ownOrigin;
}

/**
 * Whether `user` may read a row with this visibility and owner.
 *
 * `unlisted` is deliberately as open as `public` here: an unlisted row is
 * reachable by anyone holding its id, and never appears in a list. Excluding
 * it from lists is a separate filter (see `listWhere` in app.ts) — this
 * function only answers "can this one row be read".
 */
export function canRead(visibility: Visibility, ownerId: string, user: SessionUser | null): boolean {
  if (visibility === 'public' || visibility === 'unlisted') return true;
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/** Contributors edit only their own rows; the admin edits everything. */
export function canEdit(ownerId: string, user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/** Compare without leaking how far the comparison got. */
export function secureEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** Pull one cookie out of a Cookie header, without a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const SESSION_DAYS = 30;

/** Three to twenty-four letters, digits or underscores: safe in a URL and in a mention. */
export const HANDLE = /^[A-Za-z0-9_]{3,24}$/;

/**
 * A handle to start a new account with, from whatever the provider calls them.
 * `taken` is asked until a free one turns up; the suffix is random rather than
 * counted so one account's handle says nothing about how many came before.
 */
export function handleFrom(name: string, taken: (handle: string) => boolean, random = () => crypto.randomInt(1000, 10000)): string {
  const base = name.normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '').slice(0, 19);
  const stem = base.length >= 3 ? base : 'driver';
  if (base.length >= 3 && !taken(stem)) return stem;
  for (;;) {
    const candidate = `${stem}_${random()}`;
    if (!taken(candidate)) return candidate;
  }
}

/** `ADMIN_IDS=google:1234,discord:5678` — the accounts that are admins, by who the provider says they are. */
export function isAdminAccount(provider: string, providerId: string, adminIds: string | undefined): boolean {
  if (!provider || !providerId) return false;
  return (adminIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(`${provider}:${providerId}`);
}
