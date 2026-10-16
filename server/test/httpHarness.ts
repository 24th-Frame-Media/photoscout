import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { RealtimeOptions } from '../src/realtime.js';

export interface Reply { status: number; headers: Headers; json: any; text: string }
export type Client = ((method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>) & {
  jar: Map<string, string>;
};

/** Who a provider will say somebody is, in a test. */
export interface FakeProfile { id: string; name: string; picture?: string }

/**
 * Stand in for Google's and Discord's servers.
 *
 * The app runs in this process, so its calls to a provider go through the
 * same `fetch` as everything else and can be answered here: no test-only
 * sign-in route has to exist in the app for a test to sign in. The "code" a
 * test hands the callback is the profile itself, encoded, and comes back out
 * of the token endpoint as that provider would return it.
 */
function fakeProviders(): void {
  const real = globalThis.fetch;
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === 'oauth2.googleapis.com' || (url.hostname === 'discord.com' && url.pathname.endsWith('/oauth2/token'))) {
      const form = new URLSearchParams(await req.text());
      if (!form.get('code_verifier')) return new Response('{"error":"invalid_grant"}', { status: 400 });
      const profile = JSON.parse(Buffer.from(form.get('code') ?? '', 'base64url').toString('utf8')) as FakeProfile;
      const idToken = `${b64({ alg: 'none' })}.${b64({ sub: profile.id, name: profile.name, picture: profile.picture ?? '' })}.x`;
      return json({ access_token: b64(profile), token_type: 'Bearer', expires_in: 3600, id_token: idToken, scope: 'identify' });
    }
    if (url.hostname === 'discord.com' && url.pathname === '/api/users/@me') {
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const profile = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as FakeProfile;
      return json({ id: profile.id, username: profile.name.toLowerCase(), global_name: profile.name, avatar: null });
    }
    return real(input, init);
  };
}

/**
 * Boots the real Express app on a throwaway data directory and a free port.
 * `node --test` runs each file in its own process, so one app per file: the
 * database is a module singleton and DATA_DIR has to be set before it loads.
 *
 * The app is private unless told otherwise (access.ts), so a visitor would be
 * refused the public map. Most tests are about that map and its visibility
 * rules, so the harness starts it with PUBLIC_READS on. A test of the
 * instance's own access mode passes `PUBLIC_READS: ''` to leave it unset.
 */
export async function startApp(env: Record<string, string> = {}, realtime: RealtimeOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photoscout-http-'));
  Object.assign(process.env, {
    DATA_DIR: dir,
    RATE_LIMITS: 'off',
    PUBLIC_READS: '1',
    PUBLIC_URL: 'https://photoscout.test',
    GOOGLE_CLIENT_ID: 'test-google', GOOGLE_CLIENT_SECRET: 'test-google-secret',
    DISCORD_CLIENT_ID: 'test-discord', DISCORD_CLIENT_SECRET: 'test-discord-secret',
  }, env);
  fakeProviders();
  const { app } = await import('../src/app.js');
  const { attachRealtime } = await import('../src/realtime.js');
  // The OS can hand out a port fetch refuses outright ("bad port"); take another.
  let server: ReturnType<typeof app.listen>, base: string;
  for (;;) {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const refused = await fetch(base).then(() => false, (err: Error) => /bad port/.test(String((err.cause as Error | undefined)?.message)));
    if (!refused) break;
    server.close();
  }

  /** A client with its own cookie jar, so one test can act as several people. */
  function client(): Client {
    const jar = new Map<string, string>();
    const request = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
      const res = await fetch(base + url, {
        method,
        redirect: 'manual',
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq), value = pair.slice(eq + 1);
        if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, json, text };
    };
    return Object.assign(request, { jar });
  }

  /**
   * Sign a client in the way a browser would: to the provider and back.
   * Returns the callback's reply, so a test can look at where it was sent.
   */
  async function signIn(as: Client, provider: 'google' | 'discord', profile: FakeProfile): Promise<Reply> {
    const start = await as('GET', `/api/auth/${provider}/start`);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const code = Buffer.from(JSON.stringify(profile)).toString('base64url');
    return as('GET', `/api/auth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`);
  }

  // The WebSocket endpoint, on the same server, as index.ts mounts it. Options let a test shorten the heartbeat.
  const stopRealtime = attachRealtime(server, realtime);

  /**
   * A WebSocket as a browser tab would open one: the client's cookies and this site's Origin, either of
   * which a test can replace (or leave out with `null`).
   */
  function socket(as?: Client, opts: { origin?: string | null; cookie?: string | null; autoPong?: boolean } = {}): WebSocket {
    const headers: Record<string, string> = {};
    const origin = opts.origin === undefined ? 'https://photoscout.test' : opts.origin;
    if (origin !== null) headers.Origin = origin;
    const cookie = opts.cookie === undefined ? (as && as.jar.size ? [...as.jar].map(([k, v]) => `${k}=${v}`).join('; ') : null) : opts.cookie;
    if (cookie) headers.Cookie = cookie;
    return new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers, autoPong: opts.autoPong ?? true });
  }

  async function close() {
    stopRealtime();
    server.close();
    await once(server, 'close');
  }
  return { base, client, signIn, socket, close, dataDir: dir };
}
