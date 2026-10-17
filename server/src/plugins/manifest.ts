import net from 'node:net';
import semver from 'semver';
import {
  HOST_API_VERSION,
  type PermissionKind,
  type PluginManifest,
  type ServiceSpec,
  type SettingField,
} from './types.js';

/** A package the host will not run: a bad manifest, a bad archive, or a version this host cannot provide. */
export class PluginError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'PluginError';
  }
}

export const PLUGIN_CATEGORIES = ['map', 'feed', 'events', 'ai', 'tools'] as const;
export const PERMISSION_KINDS: readonly PermissionKind[] = ['network', 'secrets', 'realtime', 'llm', 'tasks', 'storage', 'events'];
const SETTING_TYPES = ['string', 'secret', 'url', 'number', 'boolean', 'select'];
/** Reverse-DNS: at least two dot-separated parts, lowercase letters, digits and hyphens. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;
/** Names a setting may not take: they are properties of every object, so a lookup would find them. */
const RESERVED_SETTING_KEYS = new Set(['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PluginError(`${what} must be a string`);
  return value;
}

function requiredText(value: unknown, what: string): string {
  const text = optionalText(value, what);
  if (text === undefined) throw new PluginError(`${what} is required`);
  return text;
}

/** A path inside the package: relative, forward slashes, no "..", no empty segments. */
function relativePath(value: unknown, what: string): string {
  const p = requiredText(value, what);
  if (p === '' || p.startsWith('/') || p.startsWith('\\') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) {
    throw new PluginError(`${what} must be a relative path with forward slashes, like "server.js"`);
  }
  if (p.split('/').some((seg) => seg === '' || seg === '..')) {
    throw new PluginError(`${what} must not contain ".." or empty path segments`);
  }
  return p;
}

/** The server entry: always a .js file. The host copies it to a .mjs file and imports that copy. */
function jsEntry(value: unknown, what: string): string {
  const p = relativePath(value, what);
  if (!p.endsWith('.js')) throw new PluginError(`${what} must be a .js file`);
  return p;
}

/** The web bundle: a .js or .mjs file, the same two the SPA loader imports (web/src/plugins/loader.ts, isBundlePath). */
function webEntry(value: unknown, what: string): string {
  const p = relativePath(value, what);
  if (!/\.m?js$/.test(p)) throw new PluginError(`${what} must be a .js or .mjs file`);
  return p;
}

/** Route patterns a plugin may declare public: a path under the plugin, letters, digits and . _ - ~ / : and *. */
const PUBLIC_ROUTE = /^\/[A-Za-z0-9._~:/*-]*$/;
/** More stars than this in one public pattern is refused: each one is a place the match has to try. */
const MAX_PUBLIC_STARS = 4;
/** A visitor's path longer than this (once normalised) is never public. */
const MAX_PUBLIC_PATH = 512;

function publicRoutesOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginError('public must be a list of route paths, like ["/places", "/stations/*"]');
  return value.map((raw) => {
    const route = requiredText(raw, 'each public route');
    if (route.length > 200 || !PUBLIC_ROUTE.test(route)) {
      throw new PluginError(`public route "${route}" must start with / and use only letters, digits, . _ ~ : - / and *`);
    }
    if (route.split('/').some((seg) => seg === '..' || seg === '.')) throw new PluginError(`public route "${route}" must not contain "." or ".." segments`);
    if (route.split('*').length - 1 > MAX_PUBLIC_STARS) throw new PluginError(`public route "${route}" may use at most ${MAX_PUBLIC_STARS} *`);
    return route;
  });
}

/**
 * Canonical form of a route, as Express matches it: no query, lower case, no trailing slash, "/" for the root.
 * The trailing slashes are taken off with a loop, not a regular expression, which backtracks on a long run of them.
 */
function canonicalRoute(raw: string): string {
  let path = raw.split('?')[0].toLowerCase();
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  path = path.slice(0, end);
  return path === '' ? '/' : path;
}

/**
 * Whether a path matches a pattern in which * is any run of characters, slashes included.
 * Linear: the first and last pieces are checked at the ends, and each middle piece is
 * found once, leftmost, after the one before. Leftmost is safe because nothing else has to fit before it.
 */
function globMatch(pattern: string, path: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === path;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (path.length < first.length + last.length || !path.startsWith(first) || !path.endsWith(last)) return false;
  const end = path.length - last.length;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === '') continue; // a run of stars
    const found = path.indexOf(part, pos);
    if (found === -1 || found + part.length > end) return false;
    pos = found + part.length;
  }
  return true;
}

/**
 * Whether a visitor who has not signed in may make this request to a plugin:
 * the method is GET or HEAD, the route matches one of the plugin's declared
 * public patterns, and the path has no "." or ".." segments and is not too long.
 */
export function publicRouteAllowed(patterns: readonly string[] | undefined, method: string, rest: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = canonicalRoute(rest);
  if (path.length > MAX_PUBLIC_PATH) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return patterns.some((pattern) => globMatch(canonicalRoute(pattern), path));
}

/**
 * Whether the public static route may serve a file of an installed version: its web
 * bundle, its icon, or anything under assets/. Never plugin.json and never the server
 * file, whatever else the manifest names (a case-insensitive disk makes the check
 * case-insensitive too).
 */
export function isPublicFile(manifest: PluginManifest, rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower === 'plugin.json' || (manifest.server !== undefined && lower === manifest.server.toLowerCase())) return false;
  if (rel === manifest.web || rel === manifest.icon) return true;
  return rel.startsWith('assets/');
}

/** A host a plugin says it reaches: an exact host (and optionally one port), or a "*.suffix" wildcard (informational only). */
export interface NetworkTarget {
  /** Lower-case hostname or IP as URL.hostname spells it (IPv6 keeps its brackets). */
  host: string;
  /** null: any port. */
  port: number | null;
  wildcard: boolean;
}

const NETWORK_DETAIL = /^(\*\.)?(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)(?::(\d{1,5}))?$/;

/**
 * Parse a `network` permission detail: "host", "host:port", "ip", "ip:port",
 * "[v6]", "[v6]:port", or "*.suffix" with an optional port. No scheme, path,
 * query, credentials or whitespace. The host must be written the way a URL
 * would normalise it (lower case, dotted-quad IPv4, compressed IPv6), so what
 * the admin reads is what the runtime matches. Returns null when it does not fit.
 */
export function parseNetworkDetail(detail: string): NetworkTarget | null {
  if (detail.length === 0 || detail.length > 255) return null;
  const m = NETWORK_DETAIL.exec(detail);
  if (!m) return null;
  const wildcard = m[1] !== undefined;
  const rawHost = m[2];
  let port: number | null = null;
  if (m[3] !== undefined) {
    port = Number(m[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  let canonical: string;
  try {
    canonical = new URL(`http://${rawHost}/`).hostname;
  } catch {
    return null;
  }
  if (canonical !== rawHost) return null; // "0x7f.1", "2130706433", "LOCALHOST", long-form IPv6
  if (rawHost.startsWith('.') || rawHost.endsWith('.') || rawHost.includes('..')) return null;
  if (wildcard && (rawHost.startsWith('[') || net.isIP(rawHost) !== 0 || !rawHost.includes('.'))) return null;
  return { host: rawHost, port, wildcard };
}

function permissionsOf(value: unknown): { kind: PermissionKind; detail?: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginError('permissions must be a list');
  return value.map((raw) => {
    if (!isRecord(raw)) throw new PluginError('each permission must be an object');
    const kind = raw.kind;
    if (typeof kind !== 'string' || !PERMISSION_KINDS.includes(kind as PermissionKind)) {
      throw new PluginError(`unknown permission "${String(kind)}"; allowed: ${PERMISSION_KINDS.join(', ')}`);
    }
    const detail = optionalText(raw.detail, 'permission detail');
    if (kind === 'network' && detail !== undefined && parseNetworkDetail(detail) === null) {
      throw new PluginError(
        `network permission detail "${detail}" must be a host or host:port, like "api.example.com", "192.168.1.20:8080" or "*.example.com" (no scheme, path or spaces)`,
      );
    }
    return detail === undefined ? { kind: kind as PermissionKind } : { kind: kind as PermissionKind, detail };
  });
}

function servicesOf(value: unknown): ServiceSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginError('services must be a list');
  return value.map((raw) => {
    if (!isRecord(raw)) throw new PluginError('each service must be an object');
    const name = requiredText(raw.name, 'service name');
    if (!SERVICE_NAME.test(name)) throw new PluginError(`service name "${name}" must be lowercase letters, digits and hyphens`);
    const image = requiredText(raw.image, `service ${name} image`);
    const port = raw.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PluginError(`service ${name} port must be a whole number from 1 to 65535`);
    }
    const service: ServiceSpec = { name, image, port };
    const health = optionalText(raw.health, `service ${name} health`);
    if (health !== undefined) service.health = health;
    const memory = optionalText(raw.memory, `service ${name} memory`);
    if (memory !== undefined) service.memory = memory;
    if (typeof raw.cpus === 'number') service.cpus = raw.cpus;
    if (isRecord(raw.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v !== 'string') throw new PluginError(`service ${name} env values must be strings`);
        env[k] = v;
      }
      service.env = env;
    }
    if (Array.isArray(raw.volumes) && raw.volumes.every((v) => typeof v === 'string')) service.volumes = raw.volumes as string[];
    if (Array.isArray(raw.devices)) {
      service.devices = raw.devices.map((d) => {
        if (!isRecord(d) || typeof d.path !== 'string') throw new PluginError(`service ${name} devices need a path`);
        return d.optional === true ? { path: d.path, optional: true } : { path: d.path };
      });
    }
    return service;
  });
}

function numberOf(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PluginError(`${what} must be a number`);
  return value;
}

function settingsOf(value: unknown): SettingField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginError('settings must be a list');
  const keys = new Set<string>();
  return value.map((raw, i) => {
    if (!isRecord(raw)) throw new PluginError(`settings[${i}] must be an object`);
    const key = requiredText(raw.key, `settings[${i}].key`);
    if (RESERVED_SETTING_KEYS.has(key)) throw new PluginError(`setting key "${key}" is reserved; choose another name`);
    if (!SETTING_KEY.test(key)) {
      throw new PluginError(`setting key "${key}" must start with a letter and use only letters, digits and underscores`);
    }
    if (keys.has(key)) throw new PluginError(`setting key "${key}" is listed more than once`);
    keys.add(key);
    const type = raw.type;
    if (typeof type !== 'string' || !SETTING_TYPES.includes(type)) {
      throw new PluginError(`setting "${key}" has unknown type "${String(type)}"; allowed: ${SETTING_TYPES.join(', ')}`);
    }
    const label = requiredText(raw.label, `setting "${key}" label`);
    const help = optionalText(raw.help, `setting "${key}" help`);
    const common: Record<string, unknown> = { key, type, label };
    if (help !== undefined) common.help = help;
    if (raw.required === true) common.required = true;

    if (type === 'number') {
      const def = numberOf(raw.default, `setting "${key}" default`);
      const min = numberOf(raw.min, `setting "${key}" min`);
      const max = numberOf(raw.max, `setting "${key}" max`);
      if (def !== undefined) common.default = def;
      if (min !== undefined) common.min = min;
      if (max !== undefined) common.max = max;
    } else if (type === 'boolean') {
      if (raw.default !== undefined && typeof raw.default !== 'boolean') throw new PluginError(`setting "${key}" default must be true or false`);
      if (raw.default !== undefined) common.default = raw.default;
    } else if (type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length === 0) throw new PluginError(`setting "${key}" needs a non-empty options list`);
      const options = raw.options.map((o) => {
        if (!isRecord(o) || typeof o.value !== 'string') throw new PluginError(`setting "${key}" options need a string value`);
        return { value: o.value, label: requiredText(o.label, `setting "${key}" option label`) };
      });
      const def = optionalText(raw.default, `setting "${key}" default`);
      if (def !== undefined && !options.some((o) => o.value === def)) throw new PluginError(`setting "${key}" default is not one of its options`);
      common.options = options;
      if (def !== undefined) common.default = def;
    } else {
      const def = optionalText(raw.default, `setting "${key}" default`);
      if (def !== undefined) common.default = def;
    }
    return common as unknown as SettingField;
  });
}

/**
 * Check a parsed plugin.json and return it in its normalised form. Unknown
 * top-level fields are ignored. Throws PluginError with a message a person can act on.
 */
export function parseManifest(json: unknown): PluginManifest {
  if (!isRecord(json)) throw new PluginError('plugin.json must be a JSON object');

  const id = requiredText(json.id, 'id');
  if (id.length > 100 || !PLUGIN_ID_PATTERN.test(id)) {
    throw new PluginError(`id "${id}" must be reverse-DNS, like "media.example.waze" (lowercase letters, digits and hyphens, at least two dot-separated parts, up to 100 characters)`);
  }
  const name = requiredText(json.name, 'name');
  if (name.length < 1 || name.length > 60) throw new PluginError('name must be 1 to 60 characters');
  const version = requiredText(json.version, 'version');
  // Only the plain form (1.2.3): semver.valid would also take "v1.2.3" and quietly normalise it.
  if (semver.valid(version) !== version) throw new PluginError(`version "${version}" is not a valid semver version (use a plain form like 1.2.3)`);
  const description = requiredText(json.description, 'description');
  const author = requiredText(json.author, 'author');
  const category = json.category;
  if (typeof category !== 'string' || !(PLUGIN_CATEGORIES as readonly string[]).includes(category)) {
    throw new PluginError(`category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`);
  }
  const range = requiredText(json.photoscout, 'photoscout');
  if (!semver.validRange(range)) throw new PluginError(`photoscout "${range}" is not a valid semver range`);
  if (!semver.satisfies(HOST_API_VERSION, range)) {
    throw new PluginError(`needs PhotoScout plugin API ${range}, but this host provides ${HOST_API_VERSION}`);
  }

  const server = json.server === undefined || json.server === null ? undefined : jsEntry(json.server, 'server');
  const web = json.web === undefined || json.web === null ? undefined : webEntry(json.web, 'web');
  const icon = json.icon === undefined || json.icon === null ? undefined : relativePath(json.icon, 'icon');
  const homepage = optionalText(json.homepage, 'homepage');

  const manifest: PluginManifest = {
    id,
    name,
    version,
    description,
    author,
    category: category as PluginManifest['category'],
    photoscout: range,
    permissions: permissionsOf(json.permissions),
    services: servicesOf(json.services),
    settings: settingsOf(json.settings),
  };
  if (homepage !== undefined) manifest.homepage = homepage;
  if (icon !== undefined) manifest.icon = icon;
  if (server !== undefined) manifest.server = server;
  if (web !== undefined) manifest.web = web;
  const publicRoutes = publicRoutesOf(json.public);
  if (publicRoutes.length > 0) manifest.public = publicRoutes;
  return manifest;
}
