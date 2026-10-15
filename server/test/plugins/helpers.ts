import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { strToU8, zipSync } from 'fflate';
import { needsAuth, type SessionUser } from '../../src/auth.js';
import { createRegistry, type KvStore, type TaskRegistry } from '../../src/tasks/registry.js';
import { createPluginRuntime, type PluginRuntime } from '../../src/plugins/runtime.js';
import { mountPlugins } from '../../src/plugins/routes.js';

/**
 * Shared scaffolding for the plugin tests. Nothing here imports the app's
 * database module, so a test never creates the real photoscout.db.
 */

export function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ps-plugins-'));
}

export function removeRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A zip of the given files (name -> text or bytes). */
export function zipOf(files: Record<string, string | Uint8Array>, opts?: Parameters<typeof zipSync>[1]): Uint8Array {
  const data: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) data[name] = typeof value === 'string' ? strToU8(value) : value;
  return zipSync(data, opts);
}

/** A server.js that answers GET /ping with its id and version. */
export const PING_SERVER = [
  'export default {',
  '  activate(ctx) {',
  "    ctx.router.get('/ping', (req, res) => {",
  '      res.json({ id: ctx.manifest.id, version: ctx.manifest.version });',
  '    });',
  '  },',
  '};',
].join('\n');

export interface PackageOpts {
  id?: string;
  version?: string;
  name?: string;
  /** Source of server.js; null leaves the server entry out of the manifest. */
  server?: string | null;
  web?: boolean;
  /** Icon path, as plugin.json "icon" (the file itself goes in extraFiles). */
  icon?: string;
  settings?: unknown[];
  services?: unknown[];
  photoscout?: string;
  /** Routes a visitor may read without signing in (plugin.json "public"). */
  public?: string[];
  extraFiles?: Record<string, string | Uint8Array>;
}

/** A complete plugin package: plugin.json plus the files it names. */
export function pluginPackage(opts: PackageOpts = {}): Uint8Array {
  const manifest: Record<string, unknown> = {
    id: opts.id ?? 'media.test.demo',
    name: opts.name ?? 'Demo',
    version: opts.version ?? '1.0.0',
    description: 'A demo plugin',
    author: 'Tests',
    category: 'tools',
    photoscout: opts.photoscout ?? '^1.0',
  };
  if (opts.server !== null) manifest.server = 'server.js';
  if (opts.web) manifest.web = 'web.js';
  if (opts.icon) manifest.icon = opts.icon;
  if (opts.settings) manifest.settings = opts.settings;
  if (opts.services) manifest.services = opts.services;
  if (opts.public) manifest.public = opts.public;
  const files: Record<string, string | Uint8Array> = { 'plugin.json': JSON.stringify(manifest), ...(opts.extraFiles ?? {}) };
  if (opts.server !== null) files['server.js'] = opts.server ?? PING_SERVER;
  if (opts.web) files['web.js'] = 'export default {};';
  return zipOf(files);
}

export interface Harness {
  runtime: PluginRuntime;
  registry: TaskRegistry;
  handle: DatabaseSync;
  root: string;
  close(): Promise<void>;
}

/** A runtime over an in-memory database, a temp root and a task registry. */
export function makeRuntime(opts: { root?: string; safeMode?: boolean; devMode?: boolean; devRoot?: string; guardedFetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Harness {
  const root = opts.root ?? tempRoot();
  const kv = new Map<string, string>();
  const kvStore: KvStore = {
    get: (key) => kv.get(key) ?? null,
    set: (key, value) => {
      kv.set(key, value);
    },
  };
  const registry = createRegistry(kvStore);
  const handle = new DatabaseSync(':memory:');
  const runtime = createPluginRuntime({
    db: { handle },
    root,
    devRoot: opts.devRoot,
    taskRegistry: registry,
    safeMode: opts.safeMode ?? false,
    devMode: opts.devMode ?? false,
    guardedFetch: opts.guardedFetch,
  });
  return {
    runtime,
    registry,
    handle,
    root,
    async close() {
      await runtime.close();
      handle.close();
      removeRoot(root);
    },
  };
}

export interface Caller {
  user: { id: string; role: 'admin' | 'contributor' } | null;
}

/**
 * An Express app with the plugin routes mounted, a host route for comparison,
 * and a fake signed-in user taken from `caller` for each request.
 */
export function pluginApp(runtime: PluginRuntime, caller: Caller = { user: { id: 'admin-1', role: 'admin' } }): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = caller.user;
    next();
  });
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  mountPlugins(app, runtime);
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}` });
  });
  return app;
}

/**
 * The /api gate as app.ts applies it, with the plugin predicate, then the plugin
 * routes and a 404 for everything else under /api. `user` is who is signed in.
 */
export function gatedApp(runtime: PluginRuntime, user: SessionUser | null): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { user: SessionUser | null }).user = user;
    next();
  });
  app.use('/api', (req, res, next) => {
    if (!needsAuth(req.method, req.baseUrl + req.path, (id, method, rest) => runtime.isPublicRoute(id, method, rest))) return next();
    if (req.user) return next();
    res.status(401).json({ error: 'Sign in required' });
  });
  mountPlugins(app, runtime);
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.originalUrl}` });
  });
  return app;
}

export interface Listening {
  base: string;
  close(): Promise<void>;
}

export async function listen(app: express.Express): Promise<Listening> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Send a raw request, without the URL normalisation fetch applies (needed to test "..": segments). */
export function rawGet(base: string, pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const { port, hostname } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, path: pathname, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** POST a zip as the `package` field of a multipart upload, the way the admin page does. */
export async function uploadPackage(base: string, zip: Uint8Array, name = 'plugin.zip'): Promise<Response> {
  const form = new FormData();
  form.append('package', new Blob([zip as BlobPart], { type: 'application/zip' }), name);
  return fetch(`${base}/api/admin/plugins/upload`, { method: 'POST', body: form });
}
