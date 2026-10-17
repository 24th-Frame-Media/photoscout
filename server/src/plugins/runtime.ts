import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse, Router } from 'express';
import { requireAdmin as defaultRequireAdmin, requireUser as defaultRequireUser } from '../auth.js';
import type { Db } from '../db.js';
import { publicFetch } from '../events/nethost.js';
import {
  registerPluginEventImporter,
  registerPluginEventSource,
  unregisterPluginEventImporter,
  unregisterPluginEventSource,
} from '../events/pluginSources.js';
import { extractEventsFromHtml } from '../events/sources/jsonld.js';
import { getSettings } from '../settings.js';
import type { TaskDef, TaskRegistry } from '../tasks/registry.js';
import { PluginError, publicRouteAllowed } from './manifest.js';
import { createPluginFetch, type Send } from './netscope.js';
import { createPluginStore, readManifestDir, readZipManifest, type PluginRow, type PluginSource, type PluginStore } from './store.js';
import { effectiveSettings, mergeSettings, redactedSettings } from './settings.js';
import {
  HOST_API_VERSION,
  type PermissionKind,
  type PluginArea,
  type PluginContext,
  type PluginEventImporterDef,
  type PluginEventItem,
  type PluginEventQuery,
  type PluginEventSourceDef,
  type PluginManifest,
  type PluginRawEvent,
  type PluginTaskDef,
  type ServerPlugin,
  type ServiceSpec,
  type SettingField,
} from './types.js';

/**
 * Starting, stopping and replacing plugins while the host keeps running.
 *
 * Every running plugin has its own express Router. One stable dispatcher is
 * mounted at /api/plugins and sends each request to the Router of the plugin
 * named in the path. Enabling, disabling, updating and rolling back a plugin is
 * then only a matter of swapping that Router, so nothing restarts.
 *
 * Plugins run in-process with full trust (as in Jellyfin). The isolation here
 * is about faults, not security: a plugin that throws, rejects or hangs is
 * marked as failed and the rest of the host carries on.
 */

const ACTIVATE_TIMEOUT_MS = 15_000;
const DEACTIVATE_TIMEOUT_MS = 5_000;
const LOG_LIMIT = 200;
/** Old module instances stay in memory after a reload; past this many, the admin page says to restart. */
const RESTART_AFTER_RELOADS = 5;
const TICK_MS = 60_000;
const DEV_RELOAD_DEBOUNCE_MS = 300;
const DEV_FILES = new Set(['server.js', 'plugin.json']);

export interface PluginLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type PluginState = 'active' | 'inactive' | 'error' | 'disabled';

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  previousVersion: string | null;
  description: string;
  author: string;
  icon: string | null;
  category: string | null;
  enabled: boolean;
  status: PluginState;
  lastError: string;
  permissions: { kind: PermissionKind; detail?: string }[];
  services: ServiceSpec[];
  settingsSchema: SettingField[];
  source: PluginSource;
}

/** What an upload left running: whether it was a first install, and the plugin's status. */
export interface InstalledPackage {
  created: boolean;
  id: string;
  version: string;
  status: PluginStatus;
}

export interface PluginRuntime {
  /** Mount once, at /api/plugins. */
  readonly dispatcher: Router;
  readonly store: PluginStore;
  loadAll(): Promise<void>;
  activate(id: string): Promise<PluginStatus>;
  deactivate(id: string): Promise<PluginStatus>;
  reload(id: string): Promise<PluginStatus>;
  setEnabled(id: string, enabled: boolean): Promise<PluginStatus>;
  /** Install a package and start it. If it does not start, the earlier version comes back. `source` is where it came from ('upload' by default). Throws PluginError. */
  installPackage(zip: Uint8Array, source?: PluginSource): Promise<InstalledPackage>;
  /** Swap back to the earlier version, and start it if the plugin is on. Throws PluginError. */
  rollback(id: string): Promise<PluginStatus>;
  uninstall(id: string, opts: { keepData: boolean }): Promise<void>;
  status(id: string): PluginStatus | null;
  statuses(): PluginStatus[];
  meta(): { safeMode: boolean; restartRecommended: boolean; hostApiVersion: string };
  /** Whether a request to /api/plugins/<id><rest> may skip the sign-in gate: the running plugin declares that route public. */
  isPublicRoute(id: string, method: string, rest: string): boolean;
  logs(id: string): PluginLogEntry[];
  settings(id: string): { values: Record<string, unknown>; secretsSet: Record<string, boolean> };
  updateSettings(id: string, body: unknown): { values: Record<string, unknown>; secretsSet: Record<string, boolean> };
  webEntries(): { id: string; version: string; name: string; web: string }[];
  /** The folder of a running plugin's version, for the public static route. Null unless that version is the one running. */
  resolveDir(id: string, version: string): string | null;
  close(): Promise<void>;
}

export interface PluginRuntimeOptions {
  /** The core database. The plugin's own SQLite is opened per plugin; this one is read for ctx.areas() (settings.ts getSettings). */
  db: Db;
  /** The plugins folder, e.g. <dataDir>/plugins. */
  root: string;
  /** Unpacked plugins for development. Default: <dirname(root)>/plugins-dev. */
  devRoot?: string;
  taskRegistry: TaskRegistry;
  requireUser?: (req: Request, res: ExpressResponse) => boolean;
  requireAdmin?: (req: Request, res: ExpressResponse) => boolean;
  /** SSRF-guarded fetch behind ctx.fetch. Default: events/nethost publicFetch. */
  guardedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * One redirect-free request on a given lookup, for plugins that declare a `network` host (see netscope.ts).
   * Plugins without one use `guardedFetch`. Default: events/shared/pinnedFetch. Tests inject a fake.
   */
  send?: Send;
  /** Default: PHOTOSCOUT_SAFE_MODE=1 in the environment. */
  safeMode?: boolean;
  /** Default: PHOTOSCOUT_PLUGIN_DEV=1 in the environment. */
  devMode?: boolean;
  /** Direct event ingestion into the events engine behind ctx.events.ingest. */
  ingestEvents?: (sourceName: string, items: readonly PluginRawEvent[]) => Promise<{ kept: number; rejected: number; outsideArea: number }>;
  /** Direct read from the events engine behind ctx.events.list. */
  listEvents?: (query?: Record<string, unknown>) => readonly PluginEventItem[];
}

/** A plugin that is running, with everything needed to stop it again. */
interface Live {
  id: string;
  version: string;
  manifest: PluginManifest;
  dir: string;
  router: Router;
  plugin: ServerPlugin | null;
  db: DatabaseSync | null;
  closed: boolean;
  listeners: Set<(s: Record<string, unknown>) => void>;
  taskNames: string[];
  eventSourceNames: string[];
  eventImporterNames: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginError(`${what} took longer than ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * ctx.areas(): the core's configured Areas, home first, read from the settings on each call. Any failure to
 * read them gives [], so a plugin that polls does not throw because the stored settings cannot be read.
 */
function readAreas(db: Db): readonly PluginArea[] {
  try {
    const settings = getSettings(db);
    const areas = [settings.home, ...settings.areas].map((a) => Object.freeze({ name: a.name, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm }));
    return Object.freeze(areas);
  } catch {
    return [];
  }
}

function openPluginDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

type AnyFn = (...args: any[]) => unknown;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

/**
 * Wrap one handler so that a rejected promise goes to next(err) rather than
 * becoming an unhandled rejection. The arity is kept: Express tells an error
 * handler from ordinary middleware by its number of parameters.
 */
function guardHandler(fn: AnyFn): AnyFn {
  if (fn.length === 4) {
    return function guardedErrorHandler(err: unknown, req: Request, res: ExpressResponse, next: NextFunction) {
      const out = fn(err, req, res, next);
      if (isThenable(out)) out.then(undefined, next);
      return out;
    };
  }
  return function guardedHandler(req: Request, res: ExpressResponse, next: NextFunction) {
    const out = fn(req, res, next);
    if (isThenable(out)) out.then(undefined, next);
    return out;
  };
}

function guardArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'function') return guardHandler(arg as AnyFn);
    if (Array.isArray(arg)) return guardArgs(arg);
    return arg;
  });
}

/** Route registrations on this router (and on its routes) are guarded, so a plugin's async handler cannot crash the host. */
function guardRouter(router: Router): Router {
  const target = router as unknown as Record<string, AnyFn>;
  for (const method of [...HTTP_METHODS, 'use'] as const) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(router) as AnyFn;
    target[method] = (...args: unknown[]) => {
      original(...guardArgs(args));
      return router;
    };
  }
  const originalRoute = target.route.bind(router) as unknown as (path: unknown) => Record<string, AnyFn>;
  target.route = (routePath: unknown) => {
    const route = originalRoute(routePath);
    for (const method of HTTP_METHODS) {
      if (typeof route[method] !== 'function') continue;
      const original = route[method].bind(route) as AnyFn;
      route[method] = (...args: unknown[]) => {
        original(...guardArgs(args));
        return route;
      };
    }
    return route;
  };
  return router;
}

export function createPluginRuntime(opts: PluginRuntimeOptions): PluginRuntime {
  const root = path.resolve(opts.root);
  const runtimeDir = path.join(root, '.runtime');
  const devRoot = path.resolve(opts.devRoot ?? path.join(path.dirname(root), 'plugins-dev'));
  const store = createPluginStore({ handle: opts.db.handle, root });
  const taskRegistry = opts.taskRegistry;
  const requireUserFn = opts.requireUser ?? defaultRequireUser;
  const requireAdminFn = opts.requireAdmin ?? defaultRequireAdmin;
  const guardedFetch = opts.guardedFetch ?? publicFetch;
  const safeMode = opts.safeMode ?? process.env.PHOTOSCOUT_SAFE_MODE === '1';
  const devMode = opts.devMode ?? process.env.PHOTOSCOUT_PLUGIN_DEV === '1';

  const live = new Map<string, Live>();
  const logs = new Map<string, PluginLogEntry[]>();
  const queues = new Map<string, Promise<unknown>>();
  const devDirs = new Map<string, string>();
  const devWatchers = new Map<string, fs.FSWatcher>();
  const devTimers = new Map<string, NodeJS.Timeout>();
  const importedBefore = new Set<string>();
  const intervalTasks = new Set<string>();
  let ticker: NodeJS.Timeout | null = null;
  let loadCounter = 0;
  let hotReloads = 0;

  function record(id: string, level: PluginLogEntry['level'], message: string): void {
    const list = logs.get(id) ?? [];
    list.push({ at: new Date().toISOString(), level, message });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    logs.set(id, list);
    const line = `[plugin:${id}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  /** Operations on one plugin run one after another, so an enable and an update cannot interleave. */
  function serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const run = previous.then(() => task());
    queues.set(id, run.catch(() => undefined));
    return run;
  }

  function storedSettings(id: string): Record<string, unknown> {
    return store.get(id)?.settings ?? {};
  }

  function dirFor(id: string, version: string): string {
    return (devMode ? devDirs.get(id) : undefined) ?? store.versionDir(id, version);
  }

  function manifestFor(row: PluginRow): PluginManifest | null {
    try {
      return readManifestDir(dirFor(row.id, row.activeVersion));
    } catch {
      return null;
    }
  }

  /** The manifest the settings are checked against: the running one, or the one on disk. Null if neither can be read. */
  function manifestOf(row: PluginRow): PluginManifest | null {
    return live.get(row.id)?.manifest ?? manifestFor(row);
  }

  function describe(row: PluginRow): PluginStatus {
    const lv = live.get(row.id);
    const manifest = lv?.manifest ?? manifestFor(row);
    const status: PluginState = !row.enabled ? 'disabled' : lv ? 'active' : row.status === 'error' ? 'error' : 'inactive';
    return {
      id: row.id,
      name: manifest?.name ?? row.id,
      version: manifest?.version ?? row.activeVersion,
      previousVersion: row.previousVersion,
      description: manifest?.description ?? '',
      author: manifest?.author ?? '',
      icon: manifest?.icon ?? null,
      category: manifest?.category ?? null,
      enabled: row.enabled,
      status,
      lastError: status === 'error' ? row.lastError : '',
      permissions: manifest?.permissions ?? [],
      services: manifest?.services ?? [],
      settingsSchema: manifest?.settings ?? [],
      source: row.source,
    };
  }

  function describeOne(id: string): PluginStatus {
    const row = store.get(id);
    if (!row) throw new PluginError('Plugin is not installed', 404);
    return describe(row);
  }

  function fail(id: string, err: unknown): void {
    const message = errorMessage(err);
    record(id, 'error', message);
    store.setStatus(id, 'error', message);
  }

  function serviceUrl(id: string, name: string): string | null {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
    const value = storedSettings(id)[`service:${name}:url`];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  function ensureTicker(): void {
    if (ticker) return;
    ticker = setInterval(() => {
      for (const name of intervalTasks) {
        taskRegistry.runIfDue(name).catch((err: unknown) => console.error(`[plugins] task ${name} failed: ${errorMessage(err)}`));
      }
    }, TICK_MS);
    ticker.unref();
  }

  function stopTickerIfIdle(): void {
    if (intervalTasks.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function registerTask(lv: Live, def: PluginTaskDef): void {
    if (lv.closed) throw new PluginError('This plugin is no longer active');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
      throw new PluginError(`task id "${def.id}" must be lowercase letters, digits and hyphens`);
    }
    const name = `plugin:${lv.id}:${def.id}`;
    if (lv.taskNames.includes(name)) throw new PluginError(`task "${def.id}" is already registered`);
    const minutes = def.intervalMinutes;
    const task: TaskDef = {
      name,
      label: `${lv.manifest.name}: ${def.name}`,
      description: def.description ?? '',
      enabled: () => true,
      run: (log) => def.run(log),
    };
    if (minutes != null) task.intervalMinutes = () => minutes;
    taskRegistry.register(task);
    lv.taskNames.push(name);
    if (minutes != null) {
      intervalTasks.add(name);
      ensureTicker();
    }
  }

  function registerEventSource(lv: Live, def: PluginEventSourceDef): void {
    if (lv.closed) throw new PluginError('This plugin is no longer active');
    if (!def || typeof def !== 'object') throw new PluginError('event source definition must be an object');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
      throw new PluginError(`event source id "${def.id}" must be lowercase letters, digits and hyphens`);
    }
    if (typeof def.label !== 'string' || !def.label.trim()) {
      throw new PluginError(`event source "${def.id}" must have a non-empty label`);
    }
    if (typeof def.fetch !== 'function') {
      throw new PluginError(`event source "${def.id}" must provide a fetch(area) function`);
    }
    const name = `plugin:${lv.id}:${def.id}`;
    if (lv.eventSourceNames.includes(name)) {
      throw new PluginError(`event source "${def.id}" is already registered`);
    }
    registerPluginEventSource(lv.id, lv.manifest.name, def);
    lv.eventSourceNames.push(name);
  }

  function registerEventImporter(lv: Live, def: PluginEventImporterDef): void {
    if (lv.closed) throw new PluginError('This plugin is no longer active');
    if (!def || typeof def !== 'object') throw new PluginError('event importer definition must be an object');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
      throw new PluginError(`event importer id "${def.id}" must be lowercase letters, digits and hyphens`);
    }
    if (typeof def.label !== 'string' || !def.label.trim()) {
      throw new PluginError(`event importer "${def.id}" must have a non-empty label`);
    }
    if (typeof def.match !== 'function' || typeof def.read !== 'function') {
      throw new PluginError(`event importer "${def.id}" must provide match(url) and read(url) functions`);
    }
    const name = `plugin:${lv.id}:${def.id}`;
    if (lv.eventImporterNames.includes(name)) {
      throw new PluginError(`event importer "${def.id}" is already registered`);
    }
    registerPluginEventImporter(lv.id, def);
    lv.eventImporterNames.push(name);
  }

  function buildContext(lv: Live): PluginContext {
    const { id, manifest } = lv;
    const fields = manifest.settings ?? [];
    const level = (lvl: PluginLogEntry['level']) => (msg: string) => record(id, lvl, msg);
    // Public-only, plus the exact hosts this manifest declares under a `network` permission.
    const pluginFetch = createPluginFetch(manifest, { publicFetch: guardedFetch, send: opts.send });
    return {
      manifest,
      router: lv.router,
      auth: {
        requireUser: (req, res) => requireUserFn(req, res),
        requireAdmin: (req, res) => requireAdminFn(req, res),
      },
      settings: {
        get: () => effectiveSettings(fields, storedSettings(id)),
        onChange: (fn) => {
          lv.listeners.add(fn);
          return () => {
            lv.listeners.delete(fn);
          };
        },
      },
      tasks: { register: (def) => registerTask(lv, def) },
      fetch: (url, init) => (lv.closed ? Promise.reject(new PluginError('This plugin is no longer active')) : pluginFetch(url, init)),
      db: lv.db as DatabaseSync,
      dataDir: store.dataDir(id),
      log: { info: level('info'), warn: level('warn'), error: level('error') },
      services: { url: (name) => serviceUrl(id, name) },
      areas: () => readAreas(opts.db),
      events: {
        registerSource: (def) => registerEventSource(lv, def),
        registerImporter: (def) => registerEventImporter(lv, def),
        ingest: async (sourceId, events) => {
          if (lv.closed) throw new PluginError('This plugin is no longer active');
          const name = `plugin:${lv.id}:${sourceId}`;
          if (!lv.eventSourceNames.includes(name)) {
            throw new PluginError(`event source "${sourceId}" is not registered by this plugin`);
          }
          if (!Array.isArray(events)) {
            throw new PluginError('events must be an array');
          }
          if (opts.ingestEvents) {
            return opts.ingestEvents(name, events);
          }
          const { ingestPluginEvents } = await import('../events/refresh.js');
          return ingestPluginEvents(name, events);
        },
        extractFromHtml: (html, pageUrl) => {
          if (lv.closed) throw new PluginError('This plugin is no longer active');
          return extractEventsFromHtml(String(html ?? ''), String(pageUrl ?? ''), 'source');
        },
        list: (query?: PluginEventQuery) => {
          if (lv.closed) throw new PluginError('This plugin is no longer active');
          if (!opts.listEvents) return [];
          const q: Record<string, unknown> = {};
          if (query?.place !== undefined) q.place = query.place;
          if (query?.category !== undefined) q.category = query.category;
          if (query?.q !== undefined) q.q = query.q;
          if (query?.from !== undefined) q.from = query.from;
          if (query?.to !== undefined) q.to = query.to;
          if (query?.limit !== undefined) q.limit = query.limit;
          return opts.listEvents(q);
        },
      },
    };
  }

  /**
   * Import a plugin's server.js as a fresh module. Each load gets a file of its
   * own: Node keys its module cache by the full URL, but tsx's loader ignores the
   * query string, so a reload from the same path would hand back the old module
   * under `npm run dev`. A new path avoids that under both loaders. The .mjs
   * extension makes the copy an ES module whatever the folder's package.json says.
   */
  async function loadModule(id: string, source: string): Promise<ServerPlugin | undefined> {
    loadCounter += 1;
    // Every load after the first one for this plugin leaves an older module in memory.
    if (importedBefore.has(id)) hotReloads += 1;
    importedBefore.add(id);
    const dir = path.join(runtimeDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const name = `server-${loadCounter}.mjs`;
    fs.copyFileSync(source, path.join(dir, name));
    const mod = (await import(pathToFileURL(path.join(dir, name)).href)) as { default?: ServerPlugin };
    // The modules already loaded keep running from memory; their copies are no longer needed.
    for (const old of fs.readdirSync(dir)) {
      if (old === name) continue;
      try {
        fs.rmSync(path.join(dir, old), { force: true });
      } catch {
        // Still locked on some systems; the next load tries again.
      }
    }
    return mod.default;
  }

  async function startPlugin(lv: Live): Promise<void> {
    if (!lv.manifest.server) return;
    fs.mkdirSync(store.dataDir(lv.id), { recursive: true });
    lv.db = openPluginDb(path.join(store.dataDir(lv.id), 'plugin.db'));
    const plugin = await loadModule(lv.id, path.join(lv.dir, lv.manifest.server));
    if (!plugin || typeof plugin.activate !== 'function') {
      throw new PluginError('server.js must default-export definePlugin({ activate })');
    }
    lv.plugin = plugin;
    await plugin.activate(buildContext(lv));
  }

  /** Stop one running plugin: its hook, its tasks, its event sources/importers, its listeners and its database. */
  async function teardown(lv: Live): Promise<void> {
    lv.closed = true;
    if (lv.plugin?.deactivate) {
      const hook = lv.plugin.deactivate.bind(lv.plugin);
      try {
        await withTimeout(Promise.resolve().then(() => hook()), DEACTIVATE_TIMEOUT_MS, 'Stopping the plugin');
      } catch (err) {
        record(lv.id, 'error', `stop failed: ${errorMessage(err)}`);
      }
    }
    for (const name of lv.taskNames) {
      taskRegistry.unregister(name);
      intervalTasks.delete(name);
    }
    lv.taskNames = [];
    for (const name of lv.eventSourceNames) {
      unregisterPluginEventSource(name);
    }
    lv.eventSourceNames = [];
    for (const name of lv.eventImporterNames) {
      unregisterPluginEventImporter(name);
    }
    lv.eventImporterNames = [];
    lv.listeners.clear();
    try {
      lv.db?.close();
    } catch {
      // Already closed.
    }
    lv.db = null;
    stopTickerIfIdle();
  }

  async function deactivateNow(id: string): Promise<void> {
    const lv = live.get(id);
    if (!lv) return;
    live.delete(id); // requests stop reaching the plugin before its hook runs
    await teardown(lv);
  }

  async function activateNow(id: string): Promise<void> {
    await deactivateNow(id);
    const row = store.get(id);
    if (!row) return;
    if (!row.enabled) {
      store.setStatus(id, 'inactive', '');
      return;
    }
    if (safeMode) {
      store.setStatus(id, 'inactive', '');
      record(id, 'warn', 'Not started: safe mode is on');
      return;
    }

    let lv: Live;
    try {
      const dir = dirFor(id, row.activeVersion);
      const manifest = readManifestDir(dir);
      lv = {
        id,
        version: manifest.version,
        manifest,
        dir,
        router: guardRouter(express.Router()),
        plugin: null,
        db: null,
        closed: false,
        listeners: new Set(),
        taskNames: [],
        eventSourceNames: [],
        eventImporterNames: [],
      };
    } catch (err) {
      fail(id, err);
      return;
    }

    try {
      await withTimeout(startPlugin(lv), ACTIVATE_TIMEOUT_MS, 'Starting the plugin');
      live.set(id, lv);
      store.setStatus(id, 'active', '');
      record(id, 'info', `started version ${lv.version}`);
    } catch (err) {
      await teardown(lv);
      fail(id, err);
    }
  }

  function activate(id: string): Promise<PluginStatus> {
    return serial(id, async () => {
      if (!store.get(id)) throw new PluginError('Plugin is not installed', 404);
      await activateNow(id);
      return describeOne(id);
    });
  }

  function deactivate(id: string): Promise<PluginStatus> {
    return serial(id, async () => {
      if (!store.get(id)) throw new PluginError('Plugin is not installed', 404);
      await deactivateNow(id);
      store.setStatus(id, 'inactive', '');
      return describeOne(id);
    });
  }

  function discoverDev(): void {
    if (!isDir(devRoot)) return;
    for (const name of fs.readdirSync(devRoot)) {
      const dir = path.join(devRoot, name);
      if (!isDir(dir)) continue;
      let manifest: PluginManifest;
      try {
        manifest = readManifestDir(dir);
      } catch (err) {
        console.error(`[plugins] dev folder ${name} skipped: ${errorMessage(err)}`);
        continue;
      }
      if (manifest.id !== name) {
        console.error(`[plugins] dev folder ${name} holds ${manifest.id}; skipped`);
        continue;
      }
      devDirs.set(manifest.id, dir);
      store.ensureDevRow(manifest);
      watchDev(manifest.id, dir);
    }
  }

  function watchDev(id: string, dir: string): void {
    try {
      // Watch the long form of the path. On Windows, a folder named with an 8.3
      // short name (KAPSIK~1) makes libuv abort the whole process on the first event.
      const watchPath = fs.realpathSync.native(dir);
      const watcher = fs.watch(watchPath, { persistent: false }, (_event, filename) => {
        if (filename && !DEV_FILES.has(String(filename))) return;
        const pending = devTimers.get(id);
        if (pending) clearTimeout(pending);
        devTimers.set(
          id,
          setTimeout(() => {
            devTimers.delete(id);
            reload(id).catch((err: unknown) => record(id, 'error', `dev reload failed: ${errorMessage(err)}`));
          }, DEV_RELOAD_DEBOUNCE_MS),
        );
      });
      watcher.on('error', (err) => record(id, 'error', `watch failed: ${errorMessage(err)}`));
      devWatchers.set(id, watcher);
    } catch (err) {
      record(id, 'warn', `not watching ${dir}: ${errorMessage(err)}`);
    }
  }

  async function loadAll(): Promise<void> {
    if (safeMode) {
      console.warn('[plugins] PHOTOSCOUT_SAFE_MODE is set: no plugin will be started');
      return;
    }
    if (devMode) discoverDev();
    for (const row of store.list()) {
      if (row.source === 'dev' && !devDirs.has(row.id)) continue;
      if (!row.enabled) continue;
      try {
        await activate(row.id);
      } catch (err) {
        console.error(`[plugins] ${row.id} did not load: ${errorMessage(err)}`);
      }
    }
  }

  function reload(id: string): Promise<PluginStatus> {
    return activate(id);
  }

  function setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    if (!store.get(id)) return Promise.reject(new PluginError('Plugin is not installed', 404));
    store.setEnabled(id, enabled);
    return enabled ? activate(id) : deactivate(id);
  }

  /**
   * Install an upload and start it. The install and the start run in the plugin's
   * queue, so an enable, a rollback or another upload cannot land in between. The
   * queue is keyed by the id, which is only known once the manifest is read.
   */
  async function installPackage(zip: Uint8Array, source: PluginSource = 'upload'): Promise<InstalledPackage> {
    const { id } = readZipManifest(zip);
    return serial(id, async () => {
      const install = store.installFromZip(zip, { source });
      const row = store.get(id);
      if (!row) throw new PluginError('The plugin could not be recorded', 500);
      const created = !install.prior;
      if (!row.enabled) {
        store.prune(id);
        return { created, id, version: install.version, status: describeOne(id) };
      }

      await activateNow(id);
      const started = describeOne(id);
      if (started.status === 'error') {
        // Put back what was there before this install, and start it again if it was running.
        const failure = started.lastError;
        store.revertInstall(id, install.prior, install.version);
        let note = '';
        if (install.prior?.enabled) {
          await activateNow(id);
          note = describeOne(id).status === 'active'
            ? ` Version ${install.prior.activeVersion} is running again.`
            : ` Version ${install.prior.activeVersion} could not be started either.`;
        }
        throw new PluginError(`The plugin did not start: ${failure}.${note}`, 422);
      }
      store.prune(id);
      return { created, id, version: install.version, status: started };
    });
  }

  function rollback(id: string): Promise<PluginStatus> {
    return serial(id, async () => {
      const row = store.get(id);
      if (!row) throw new PluginError('Plugin is not installed', 404);
      store.rollback(id);
      if (!row.enabled) return describeOne(id);

      await activateNow(id);
      const started = describeOne(id);
      if (started.status === 'error') {
        // The earlier version will not start: swap back so the working one is current again.
        store.rollback(id);
        await activateNow(id);
        const note = describeOne(id).status === 'active'
          ? `Version ${row.activeVersion} is running again.`
          : `Version ${row.activeVersion} could not be started either.`;
        throw new PluginError(`Version ${row.previousVersion} did not start: ${started.lastError}. ${note}`, 422);
      }
      return started;
    });
  }

  async function uninstall(id: string, opts: { keepData: boolean }): Promise<void> {
    await serial(id, async () => {
      if (!store.get(id)) throw new PluginError('Plugin is not installed', 404);
      await deactivateNow(id);
      devWatchers.get(id)?.close();
      devWatchers.delete(id);
      devDirs.delete(id);
      store.uninstall(id, opts);
      fs.rmSync(path.join(runtimeDir, id), { recursive: true, force: true });
      logs.delete(id);
    });
  }

  function settings(id: string): { values: Record<string, unknown>; secretsSet: Record<string, boolean> } {
    const row = store.get(id);
    if (!row) throw new PluginError('Plugin is not installed', 404);
    const manifest = manifestOf(row);
    // Without a manifest there is no list of declared keys, so nothing is shown.
    if (!manifest) return { values: {}, secretsSet: {} };
    return redactedSettings(manifest.settings ?? [], row.settings, (manifest.services ?? []).map((s) => s.name));
  }

  function updateSettings(id: string, body: unknown): { values: Record<string, unknown>; secretsSet: Record<string, boolean> } {
    const row = store.get(id);
    if (!row) throw new PluginError('Plugin is not installed', 404);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new PluginError('Settings must be a JSON object');
    const manifest = manifestOf(row);
    if (!manifest) throw new PluginError("The plugin's package cannot be read, so its settings cannot be changed", 500);
    const fields = manifest.settings ?? [];
    const next = mergeSettings(fields, row.settings, body as Record<string, unknown>);
    store.saveSettings(id, next);
    const lv = live.get(id);
    if (lv) {
      const effective = effectiveSettings(fields, next);
      for (const fn of [...lv.listeners]) {
        try {
          fn({ ...effective });
        } catch (err) {
          record(id, 'error', `settings listener failed: ${errorMessage(err)}`);
        }
      }
    }
    return redactedSettings(fields, next, (manifest.services ?? []).map((s) => s.name));
  }

  function answerFailure(id: string, req: Request, res: ExpressResponse, err: unknown): void {
    record(id, 'error', `${req.method} ${req.originalUrl}: ${errorMessage(err)}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'Plugin failed' });
  }

  // The dispatcher: /api/plugins/<id>/<rest> goes to the running plugin's Router.
  const dispatcher = express.Router();
  dispatcher.use((req: Request, res: ExpressResponse, next: NextFunction) => {
    const match = /^\/([^/?]+)([^?]*)(\?.*)?$/.exec(req.url);
    if (!match) return next();
    const [, id, rest, query = ''] = match;
    const lv = live.get(id);
    if (!lv) return res.status(404).json({ error: 'Plugin not active' });
    const outerUrl = req.url;
    const outerBase = req.baseUrl;
    req.baseUrl = `${outerBase}/${id}`;
    req.url = (rest || '/') + query;
    lv.router(req, res, (err?: unknown) => {
      req.url = outerUrl;
      req.baseUrl = outerBase;
      if (!err) return next();
      answerFailure(id, req, res, err);
    });
  });

  async function close(): Promise<void> {
    for (const watcher of devWatchers.values()) watcher.close();
    devWatchers.clear();
    for (const timer of devTimers.values()) clearTimeout(timer);
    devTimers.clear();
    for (const id of [...live.keys()]) await serial(id, () => deactivateNow(id));
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  return {
    dispatcher,
    store,
    loadAll,
    activate,
    deactivate,
    reload,
    setEnabled,
    installPackage,
    rollback,
    uninstall,
    status: (id) => {
      const row = store.get(id);
      return row ? describe(row) : null;
    },
    statuses: () => store.list().map(describe),
    meta: () => ({ safeMode, restartRecommended: hotReloads > RESTART_AFTER_RELOADS, hostApiVersion: HOST_API_VERSION }),
    isPublicRoute: (id, method, rest) => {
      const lv = live.get(id);
      return lv ? publicRouteAllowed(lv.manifest.public, method, rest) : false;
    },
    logs: (id) => [...(logs.get(id) ?? [])],
    settings,
    updateSettings,
    webEntries: () =>
      [...live.values()]
        .filter((lv) => lv.manifest.web)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((lv) => ({ id: lv.id, version: lv.version, name: lv.manifest.name, web: `/plugins/${lv.id}/${lv.version}/${lv.manifest.web}` })),
    resolveDir: (id, version) => {
      // Only the version that is running: a disabled or failed plugin, and the one before the current, are not served.
      const lv = live.get(id);
      if (!lv || lv.version !== version) return null;
      // A dev folder's version can change on reload before its row follows, so a dev folder counts as installed.
      if (devDirs.get(id) !== lv.dir && store.get(id)?.activeVersion !== version) return null;
      return lv.dir;
    },
    close,
  };
}
