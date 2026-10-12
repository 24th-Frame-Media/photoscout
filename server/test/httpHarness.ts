import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export interface Reply { status: number; headers: Headers; json: any; text: string }

/**
 * Boots the real Express app on a throwaway data directory and a free port.
 * `node --test` runs each file in its own process, so one app per file: the
 * database is a module singleton and DATA_DIR has to be set before it loads.
 */
export async function startApp(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photoscout-http-'));
  Object.assign(process.env, { DATA_DIR: dir, INSTANCE_MODE: 'private' }, env);
  const { app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** A client with its own cookie jar, so one test can act as several users. */
  function client() {
    const jar = new Map<string, string>();
    return async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
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
  }

  async function close() {
    server.close();
    await once(server, 'close');
  }
  return { base, client, close, dataDir: dir };
}
