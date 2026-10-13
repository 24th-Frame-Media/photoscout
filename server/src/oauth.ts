import { Discord, Google, decodeIdToken, generateCodeVerifier, generateState } from 'arctic';
import { Db } from './db.js';

/**
 * Sign-in with Google or Discord: authorization code with PKCE, through arctic.
 *
 * Nothing here is kept but who the provider says somebody is — its id for
 * them, a display name to make a handle from and a picture. No email is asked
 * for, so there is none to leak. The tokens are used once and dropped.
 *
 * A provider's client id and secret come from the environment, or failing
 * that from what an admin saved under Settings → Sign-in. One with neither is
 * simply not offered.
 */

export type ProviderName = 'google' | 'discord';

export interface Profile {
  providerId: string;
  name: string;
  avatar: string;
}

interface Provider {
  authorizationUrl(state: string, verifier: string): URL;
  profile(code: string, verifier: string): Promise<Profile>;
}

/** Where this app is reached from outside, with no trailing slash. A provider redirects back to it. */
export function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:5174').replace(/\/+$/, '');
}

export const PROVIDERS: ProviderName[] = ['google', 'discord'];

const ENV: Record<ProviderName, [string, string]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  discord: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
};

type Stored = Partial<Record<ProviderName, { clientId: string; clientSecret: string }>>;

/** Kept in its own kv row, apart from settings, so no settings read can carry a secret along. */
function stored(db: Db): Stored {
  const raw = db.getKv('auth');
  return raw ? (JSON.parse(raw) as Stored) : {};
}

/** Whether the environment sets this provider, in which case the stored pair is ignored. */
const fromEnv = (name: ProviderName) => Boolean(process.env[ENV[name][0]] || process.env[ENV[name][1]]);

/** The client id and secret in effect: the environment's if it sets either, else what was saved. */
export function credentials(db: Db, name: ProviderName): { id: string; secret: string } {
  if (fromEnv(name)) return { id: process.env[ENV[name][0]] ?? '', secret: process.env[ENV[name][1]] ?? '' };
  const s = stored(db)[name];
  return { id: s?.clientId ?? '', secret: s?.clientSecret ?? '' };
}

/** What Settings → Sign-in shows an admin. Never the secret, only whether there is one. */
export function authConfigView(db: Db) {
  return {
    publicUrl: publicUrl(),
    publicUrlFromEnv: Boolean(process.env.PUBLIC_URL),
    adminIdsSet: Boolean(process.env.ADMIN_IDS?.trim()),
    providers: PROVIDERS.map((name) => {
      const c = credentials(db, name);
      return {
        name, clientId: c.id, secretSet: Boolean(c.secret), fromEnv: fromEnv(name),
        ready: Boolean(c.id && c.secret), redirectUrl: `${publicUrl()}/api/auth/${name}/callback`,
      };
    }),
  };
}

const CLIENT_ID = /^[\w.-]{1,200}$/;
const SECRET = /^[!-~]{1,200}$/;

/**
 * Save or clear one provider's pair. A blank secret keeps the one saved, so
 * the id can be corrected without pasting the secret again. Returns why it was
 * refused, or null.
 */
export function updateCredentials(db: Db, name: string, body: { clientId?: unknown; clientSecret?: unknown; clear?: unknown }): string | null {
  if (!(PROVIDERS as string[]).includes(name)) return 'No such sign-in';
  const p = name as ProviderName;
  if (fromEnv(p)) return `Set by ${ENV[p][0]} in the environment — change it there`;
  const all = stored(db);
  if (body.clear === true) delete all[p];
  else {
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const given = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    const clientSecret = given || all[p]?.clientSecret || '';
    if (!CLIENT_ID.test(clientId)) return 'That client id does not look right';
    if (!SECRET.test(clientSecret)) return given ? 'That client secret does not look right' : 'A client secret is needed';
    all[p] = { clientId, clientSecret };
  }
  db.setKv('auth', JSON.stringify(all));
  return null;
}

function google(db: Db): Provider | null {
  const { id, secret } = credentials(db, 'google');
  if (!id || !secret) return null;
  const client = new Google(id, secret, `${publicUrl()}/api/auth/google/callback`);
  return {
    authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ['openid', 'profile']),
    async profile(code, verifier) {
      const tokens = await client.validateAuthorizationCode(code, verifier);
      // Not signature-checked, and need not be: it came straight from Google's
      // token endpoint over TLS in answer to our own code, not from a browser.
      const claims = decodeIdToken(tokens.idToken()) as { sub?: string; name?: string; picture?: string };
      if (!claims.sub) throw new Error('Google sent no account id');
      return { providerId: claims.sub, name: claims.name ?? '', avatar: claims.picture ?? '' };
    },
  };
}

function discord(db: Db): Provider | null {
  const { id, secret } = credentials(db, 'discord');
  if (!id || !secret) return null;
  const client = new Discord(id, secret, `${publicUrl()}/api/auth/discord/callback`);
  return {
    authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ['identify']),
    async profile(code, verifier) {
      const tokens = await client.validateAuthorizationCode(code, verifier);
      const res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Discord answered ${res.status}`);
      const me = (await res.json()) as { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
      if (!me.id) throw new Error('Discord sent no account id');
      return {
        providerId: me.id,
        name: me.global_name || me.username || '',
        avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : '',
      };
    },
  };
}

const BUILDERS: Record<ProviderName, (db: Db) => Provider | null> = { google, discord };

export function provider(db: Db, name: string): Provider | null {
  return Object.hasOwn(BUILDERS, name) ? BUILDERS[name as ProviderName](db) : null;
}

/** The providers that are set up, in the order the sign-in page shows them. */
export function configuredProviders(db: Db): ProviderName[] {
  return PROVIDERS.filter((name) => BUILDERS[name](db) !== null);
}

export { generateCodeVerifier, generateState };
