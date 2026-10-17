import { logActivity } from '../activity.js';
import type { WebPlugin } from './api.js';
import { pluginRegistry, type PluginInfo, type PluginRegistry } from './registry.js';

/**
 * Finds the active web bundles, imports each one and activates it.
 *
 * Failure handling is the point of this file: nothing here may throw into the
 * app. A bad list, a 404, a syntax error in a bundle, a bundle with no default
 * export, an `activate` that throws or hangs: each is logged (console + the
 * Activity panel), recorded on the registry, and costs only that one plugin.
 */

/** One row of `GET /api/plugins-web`. */
export interface WebEntry {
  id: string;
  version: string;
  name: string;
  /** Same-origin path of the bundle: `/plugins/<id>/<version>/<file>`. */
  web: string;
}

export interface LoaderDeps {
  registry?: PluginRegistry;
  /** Default: `fetch('/api/plugins-web')`. Must resolve to a Response. */
  fetchList?: () => Promise<Response>;
  /** Default: a native dynamic `import()`. Tests inject a function returning a fake module. */
  importModule?: (url: string) => Promise<unknown>;
  importTimeoutMs?: number;
}

export type LoadOutcome =
  /** The list was read; each entry either activated or failed. */
  | { kind: 'loaded'; active: string[]; failed: string[] }
  /** The server refused or could not answer the list (signed-out on a private instance, offline). Nothing was loaded and a later call may retry. */
  | { kind: 'unavailable'; reason: string };

const IMPORT_TIMEOUT_MS = 15_000;
const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/; // the server's PLUGIN_ID_PATTERN
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** Keep the rows that have the right shape; say why for the rest. */
export function parseEntries(raw: unknown, onSkip: (why: string) => void = () => {}): WebEntry[] {
  if (!Array.isArray(raw)) {
    onSkip('the plugin list was not an array');
    return [];
  }
  const out: WebEntry[] = [];
  const seen = new Set<string>();
  for (const row of raw as unknown[]) {
    const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
    const { id, version, name, web } = r;
    if (typeof id !== 'string' || !ID_RE.test(id)) { onSkip(`an entry has no valid id`); continue; }
    if (typeof version !== 'string' || !VERSION_RE.test(version)) { onSkip(`${id}: invalid version`); continue; }
    if (typeof web !== 'string' || !isBundlePath(id, version, web)) { onSkip(`${id}: web bundle path is not /plugins/${id}/${version}/<file>`); continue; }
    if (seen.has(id)) { onSkip(`${id}: listed twice`); continue; }
    seen.add(id);
    out.push({ id, version, name: typeof name === 'string' && name ? name : id, web });
  }
  return out;
}

/**
 * The only URLs the SPA will `import()`: this plugin's own versioned folder on
 * this origin. No scheme, no host, no `..`, no query or fragment.
 */
export function isBundlePath(id: string, version: string, web: string): boolean {
  const prefix = `/plugins/${id}/${version}/`;
  if (!web.startsWith(prefix)) return false;
  const rest = web.slice(prefix.length);
  if (rest === '' || /[?#\\]/.test(rest)) return false;
  return rest.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.'))
    && /\.m?js$/.test(rest);
}

/** The shape check on a loaded module: `export default definePlugin({ activate })`. */
export function pluginOf(mod: unknown): WebPlugin {
  const def = (mod as { default?: unknown } | null)?.default;
  if (typeof def !== 'object' || def === null || typeof (def as { activate?: unknown }).activate !== 'function') {
    throw new Error('the bundle must default-export definePlugin({ activate })');
  }
  const plugin = def as WebPlugin;
  if (plugin.deactivate !== undefined && typeof plugin.deactivate !== 'function') {
    throw new Error('deactivate must be a function');
  }
  return plugin;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms / 1000} seconds to download`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Vite must not try to resolve the URL at build time. */
const nativeImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

let inflight: Promise<LoadOutcome> | null = null;

/**
 * Load every active web plugin into the registry. Never rejects. The default
 * registry is loaded once per page: a second call while or after loading returns
 * the first outcome (React StrictMode runs effects twice in development). An
 * `unavailable` outcome is not remembered, so a later call may retry.
 */
export function loadWebPlugins(deps: LoaderDeps = {}): Promise<LoadOutcome> {
  const registry = deps.registry ?? pluginRegistry;
  const shared = registry === pluginRegistry && !deps.fetchList && !deps.importModule;
  if (shared && inflight) return inflight;
  const run = loadOnce(registry, deps).then((outcome) => {
    if (shared && outcome.kind === 'unavailable') inflight = null;
    return outcome;
  });
  if (shared) inflight = run;
  return run;
}

async function loadOnce(registry: PluginRegistry, deps: LoaderDeps): Promise<LoadOutcome> {
  registry.setPhase('loading');
  try {
    const fetchList = deps.fetchList ?? (() => fetch('/api/plugins-web', { credentials: 'same-origin' }));
    let res: Response;
    try {
      res = await fetchList();
    } catch (err) {
      console.warn(`[plugins] could not reach the plugin list: ${messageOf(err)}`);
      return { kind: 'unavailable', reason: 'offline' };
    }
    if (res.status === 401 || res.status === 403) {
      // A private instance and nobody signed in: expected, not an error. Plugins load once there is a session.
      return { kind: 'unavailable', reason: 'sign-in required' };
    }
    if (!res.ok) {
      console.warn(`[plugins] the plugin list answered HTTP ${res.status}`);
      logActivity('Plugins', 'Plugins could not be loaded', 'warning');
      return { kind: 'unavailable', reason: `HTTP ${res.status}` };
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    const entries = parseEntries(raw, (why) => console.warn(`[plugins] skipped: ${why}`));

    const importModule = deps.importModule ?? nativeImport;
    const results = await Promise.all(entries.map((entry) => loadOne(registry, entry, importModule, deps.importTimeoutMs ?? IMPORT_TIMEOUT_MS)));
    return {
      kind: 'loaded',
      active: entries.filter((_, i) => results[i]).map((e) => e.id),
      failed: entries.filter((_, i) => !results[i]).map((e) => e.id),
    };
  } finally {
    registry.setPhase('ready');
  }
}

/** True if the plugin is now active. Never throws. */
async function loadOne(registry: PluginRegistry, entry: WebEntry, importModule: (url: string) => Promise<unknown>, importTimeoutMs: number): Promise<boolean> {
  const info: PluginInfo = { id: entry.id, name: entry.name, version: entry.version };
  let plugin: WebPlugin;
  try {
    plugin = pluginOf(await timeout(importModule(entry.web), importTimeoutMs));
  } catch (err) {
    registry.recordFailure(info, messageOf(err));
    return false;
  }
  try {
    await registry.activate(info, plugin);
    return true;
  } catch {
    return false; // the registry has already rolled back, logged and recorded it
  }
}
