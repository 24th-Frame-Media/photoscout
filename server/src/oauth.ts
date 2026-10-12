import { Discord, Google, decodeIdToken, generateCodeVerifier, generateState } from 'arctic';

/**
 * Sign-in with Google or Discord: authorization code with PKCE, through arctic.
 *
 * Nothing here is kept but who the provider says somebody is — its id for
 * them, a display name to make a handle from and a picture. No email is asked
 * for, so there is none to leak. The tokens are used once and dropped.
 *
 * A provider with no client id in the environment is simply not offered.
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

function google(): Provider | null {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
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

function discord(): Provider | null {
  const id = process.env.DISCORD_CLIENT_ID;
  const secret = process.env.DISCORD_CLIENT_SECRET;
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

const BUILDERS: Record<ProviderName, () => Provider | null> = { google, discord };

export function provider(name: string): Provider | null {
  return Object.hasOwn(BUILDERS, name) ? BUILDERS[name as ProviderName]() : null;
}

/** The providers that are set up, in the order the sign-in page shows them. */
export function configuredProviders(): ProviderName[] {
  return (Object.keys(BUILDERS) as ProviderName[]).filter((name) => BUILDERS[name]() !== null);
}

export { generateCodeVerifier, generateState };
