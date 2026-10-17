import { createHash } from 'node:crypto';
import semver from 'semver';
import { BlockedHostError, publicLookup, readCapped, TooLargeError } from '../events/nethost.js';
import { pinnedFetch } from '../events/shared/pinnedFetch.js';
import { assertPublicUrl, SsrfError } from '../ssrf.js';
import { MAX_PACKAGE_BYTES } from './archive.js';
import { PLUGIN_ID_PATTERN, PluginError } from './manifest.js';
import { readZipManifest } from './store.js';
import type { InstalledPackage, PluginRuntime } from './runtime.js';
import type { PluginManifest } from './types.js';

/**
 * Installing a plugin from a registry: a JSON catalogue (`registry.json`) that
 * lists plugins, each version with the URL of its .zip and the zip's sha256.
 *
 * The registry is the trust root: whoever controls a configured registry
 * controls what an admin can install from it, and a plugin runs in-process with
 * full app access. What this module guarantees is narrower and mechanical:
 *   - only registries an admin has configured are ever fetched (no open proxy);
 *   - every outbound request is https-only, SSRF-checked on every redirect hop,
 *     connects only to public addresses, and is capped in size and time;
 *   - the server hashes the zip itself and refuses a mismatch;
 *   - the zip's own manifest must name the id and version the registry promised,
 *     so a registry entry cannot overwrite some other installed plugin;
 *   - nothing installs except on an explicit admin POST.
 */

/** The registry every instance starts with. PLUGIN_REGISTRY_URL overrides it (still https only). */
export const DEFAULT_PLUGIN_REGISTRY: string =
  process.env.PLUGIN_REGISTRY_URL?.trim() || 'https://raw.githubusercontent.com/kapsikkum/photoscout-plugins/main/registry.json';

export const REGISTRY_KV_KEY = 'pluginRegistries';
export const MAX_REGISTRY_BYTES = 1024 * 1024;
export const REGISTRY_TIMEOUT_MS = 15_000;
export const PACKAGE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const MAX_CUSTOM_REGISTRIES = 20;
const MAX_URL_LENGTH = 2048;
const MAX_REGISTRY_PLUGINS = 1000;
const MAX_VERSIONS = 200;

// --- types ------------------------------------------------------------------------

export interface RegistryVersion {
  version: string;
  zip: string;
  sha256: string;
  minCore?: string;
  size?: number;
}

export interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  category?: string;
  latest: string;
  versions: RegistryVersion[];
}

export interface RegistryEntry {
  url: string;
  isDefault: boolean;
}

/** Where the custom registry list lives: the app's kv table in production, a Map in tests. */
export interface RegistryKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface RemoteDeps {
  kv: RegistryKv;
  /** The outbound request. Default: a fetch whose socket only connects to public addresses. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The SSRF check, run on the first URL and on every redirect hop. Default: ssrf.ts assertPublicUrl. */
  assertUrl: (url: string) => Promise<unknown>;
  defaultRegistry: string;
}

export function createRemoteDeps(partial: Partial<RemoteDeps> = {}): RemoteDeps {
  const mem = new Map<string, string>();
  return {
    kv: partial.kv ?? { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) },
    fetch: partial.fetch ?? ((url, init) => pinnedFetch(url, init, publicLookup as Parameters<typeof pinnedFetch>[2])),
    assertUrl: partial.assertUrl ?? ((url) => assertPublicUrl(url)),
    defaultRegistry: partial.defaultRegistry ?? DEFAULT_PLUGIN_REGISTRY,
  };
}

// --- URLs ---------------------------------------------------------------------------

/** A registry or zip URL in its canonical form. https only, no credentials, no fragment. Throws PluginError. */
export function normalizeHttpsUrl(raw: unknown, what = 'URL'): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new PluginError(`${what} is required`);
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) throw new PluginError(`${what} is too long`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PluginError(`${what} is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new PluginError(`${what} must be an https URL`);
  if (url.username || url.password) throw new PluginError(`${what} must not contain credentials`);
  url.hash = '';
  return url.toString();
}

/** Turn a failure of the guard, the network or the size cap into a PluginError with a clear status. */
function fetchFailure(what: string, err: unknown): PluginError {
  if (err instanceof PluginError) return err;
  if (err instanceof SsrfError || err instanceof BlockedHostError) return new PluginError(`${what} was refused: ${err.message}`, 400);
  if (err instanceof TooLargeError) return new PluginError(`${what} is too large`, 413);
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return new PluginError(`${what} timed out`, 504);
  return new PluginError(`${what} could not be fetched: ${err instanceof Error ? err.message : String(err)}`, 502);
}

/**
 * GET `rawUrl` through the guard and read at most `maxBytes` of the body.
 * Redirects are walked by hand so each hop is held to https and the SSRF check.
 */
export async function fetchGuarded(deps: RemoteDeps, rawUrl: string, opts: { maxBytes: number; timeoutMs: number; what: string }): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let target = normalizeHttpsUrl(rawUrl, opts.what);
    for (let hop = 0; ; hop++) {
      await deps.assertUrl(target);
      const res = await deps.fetch(target, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: '*/*' } });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) throw new PluginError(`${opts.what} redirected too many times`, 502);
        target = normalizeHttpsUrl(new URL(location, target).toString(), `${opts.what} redirect`);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new PluginError(`${opts.what} returned HTTP ${res.status}`, 502);
      }
      return await readCapped(res, opts.maxBytes);
    }
  } catch (err) {
    throw fetchFailure(opts.what, err);
  } finally {
    clearTimeout(timer);
  }
}

// --- the list of registries ---------------------------------------------------------

function customUrls(deps: RemoteDeps): string[] {
  try {
    const raw = deps.kv.get(REGISTRY_KV_KEY);
    if (!raw) return [];
    const urls = (JSON.parse(raw) as { urls?: unknown } | null)?.urls;
    if (!Array.isArray(urls)) return [];
    const out: string[] = [];
    for (const u of urls) {
      if (typeof u !== 'string') continue;
      try {
        out.push(normalizeHttpsUrl(u));
      } catch {
        // a row that is no longer a valid registry URL is dropped
      }
    }
    return out;
  } catch {
    return [];
  }
}

function defaultUrl(deps: RemoteDeps): string {
  try {
    return normalizeHttpsUrl(deps.defaultRegistry, 'The default registry');
  } catch {
    return deps.defaultRegistry;
  }
}

/** The default registry first, then the admin's own, without repeats. */
export function listRegistries(deps: RemoteDeps): RegistryEntry[] {
  const def = defaultUrl(deps);
  const out: RegistryEntry[] = [{ url: def, isDefault: true }];
  for (const url of customUrls(deps)) if (!out.some((e) => e.url === url)) out.push({ url, isDefault: false });
  return out;
}

export async function addRegistry(deps: RemoteDeps, rawUrl: unknown): Promise<RegistryEntry[]> {
  const url = normalizeHttpsUrl(rawUrl, 'Registry URL');
  try {
    await deps.assertUrl(url);
  } catch (err) {
    throw fetchFailure('Registry URL', err);
  }
  const current = listRegistries(deps);
  if (current.some((e) => e.url === url)) throw new PluginError('That registry is already added');
  if (current.length - 1 >= MAX_CUSTOM_REGISTRIES) throw new PluginError(`At most ${MAX_CUSTOM_REGISTRIES} custom registries`);
  deps.kv.set(REGISTRY_KV_KEY, JSON.stringify({ urls: [...customUrls(deps), url] }));
  return listRegistries(deps);
}

export function removeRegistry(deps: RemoteDeps, rawUrl: unknown): RegistryEntry[] {
  const url = normalizeHttpsUrl(rawUrl, 'Registry URL');
  const current = listRegistries(deps);
  const hit = current.find((e) => e.url === url);
  if (!hit) throw new PluginError('That registry is not configured', 404);
  if (hit.isDefault) throw new PluginError('The default registry cannot be removed');
  deps.kv.set(REGISTRY_KV_KEY, JSON.stringify({ urls: customUrls(deps).filter((u) => u !== url) }));
  return listRegistries(deps);
}

// --- registry.json ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, what: string, max = 2000): string {
  if (typeof v !== 'string' || v.trim() === '') throw new PluginError(`registry: ${what} must be a non-empty string`, 502);
  if (v.length > max) throw new PluginError(`registry: ${what} is too long`, 502);
  return v;
}

function optionalText(v: unknown, what: string, max = 2000): string | undefined {
  if (v === undefined || v === null) return undefined;
  return text(v, what, max);
}

function parseVersion(raw: unknown, owner: string): RegistryVersion {
  if (!isRecord(raw)) throw new PluginError(`registry: ${owner} has a version that is not an object`, 502);
  const version = text(raw.version, `${owner} version`, 64);
  if (semver.valid(version) !== version) throw new PluginError(`registry: ${owner} version "${version}" is not a plain semver version`, 502);
  const where = `${owner}@${version}`;
  let zip: string;
  try {
    zip = normalizeHttpsUrl(raw.zip, `${where} zip`);
  } catch (err) {
    throw new PluginError(`registry: ${(err as Error).message}`, 502);
  }
  const sha256 = text(raw.sha256, `${where} sha256`, 64);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) throw new PluginError(`registry: ${where} sha256 must be 64 hex characters`, 502);
  const out: RegistryVersion = { version, zip, sha256: sha256.toLowerCase() };
  const minCore = optionalText(raw.minCore, `${where} minCore`, 64);
  if (minCore !== undefined) {
    if (!semver.validRange(minCore)) throw new PluginError(`registry: ${where} minCore "${minCore}" is not a valid semver range`, 502);
    out.minCore = minCore;
  }
  if (raw.size !== undefined && raw.size !== null) {
    if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0) throw new PluginError(`registry: ${where} size must be a non-negative integer`, 502);
    out.size = raw.size;
  }
  return out;
}

/** Validate a parsed registry.json against the contract and return clean plugin entries. Throws PluginError(502). */
export function parseRegistry(json: unknown): RegistryPlugin[] {
  if (!isRecord(json)) throw new PluginError('registry: not a JSON object', 502);
  if (json.version !== 1) throw new PluginError(`registry: unsupported version ${JSON.stringify(json.version)} (expected 1)`, 502);
  if (!Array.isArray(json.plugins)) throw new PluginError('registry: "plugins" must be a list', 502);
  if (json.plugins.length > MAX_REGISTRY_PLUGINS) throw new PluginError('registry: too many plugins', 502);

  const seen = new Set<string>();
  return json.plugins.map((raw): RegistryPlugin => {
    if (!isRecord(raw)) throw new PluginError('registry: a plugin entry is not an object', 502);
    const id = text(raw.id, 'plugin id', 128);
    if (!PLUGIN_ID_PATTERN.test(id)) throw new PluginError(`registry: "${id}" is not a valid plugin id`, 502);
    if (seen.has(id)) throw new PluginError(`registry: "${id}" is listed twice`, 502);
    seen.add(id);
    if (!Array.isArray(raw.versions) || raw.versions.length === 0) throw new PluginError(`registry: ${id} has no versions`, 502);
    if (raw.versions.length > MAX_VERSIONS) throw new PluginError(`registry: ${id} has too many versions`, 502);
    const versions = raw.versions.map((v) => parseVersion(v, id));
    if (new Set(versions.map((v) => v.version)).size !== versions.length) throw new PluginError(`registry: ${id} lists a version twice`, 502);

    // `latest` is part of the contract; if a registry leaves it out, the highest version stands in.
    let latest = optionalText(raw.latest, `${id} latest`, 64);
    if (latest === undefined) latest = [...versions].sort((a, b) => semver.rcompare(a.version, b.version))[0].version;
    else if (!versions.some((v) => v.version === latest)) throw new PluginError(`registry: ${id} latest "${latest}" is not in its versions`, 502);

    const out: RegistryPlugin = {
      id,
      name: text(raw.name, `${id} name`, 200),
      description: optionalText(raw.description, `${id} description`, 2000) ?? '',
      author: optionalText(raw.author, `${id} author`, 200) ?? '',
      latest,
      versions,
    };
    const homepage = optionalText(raw.homepage, `${id} homepage`, MAX_URL_LENGTH);
    if (homepage !== undefined) out.homepage = homepage;
    const category = optionalText(raw.category, `${id} category`, 64);
    if (category !== undefined) out.category = category;
    return out;
  });
}

function requireConfigured(deps: RemoteDeps, rawUrl: unknown): string {
  const url = normalizeHttpsUrl(rawUrl ?? deps.defaultRegistry, 'Registry URL');
  if (!listRegistries(deps).some((e) => e.url === url)) throw new PluginError('That registry is not configured; add it first', 400);
  return url;
}

/** Fetch, parse and validate one configured registry. */
export async function fetchRegistry(deps: RemoteDeps, rawUrl: unknown): Promise<{ url: string; plugins: RegistryPlugin[] }> {
  const url = requireConfigured(deps, rawUrl);
  const body = await fetchGuarded(deps, url, { maxBytes: MAX_REGISTRY_BYTES, timeoutMs: REGISTRY_TIMEOUT_MS, what: 'The registry' });
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new PluginError('registry: not valid JSON', 502);
  }
  return { url, plugins: parseRegistry(json) };
}

// --- installing -----------------------------------------------------------------------

export interface RemoteRequest {
  registryUrl: unknown;
  id: unknown;
  version?: unknown;
}

export interface VerifiedPackage {
  zip: Uint8Array;
  entry: RegistryPlugin;
  version: RegistryVersion;
  manifest: PluginManifest;
}

/**
 * Resolve the request in its registry, download the zip and prove it is the one
 * the registry named: sha256 computed here, and the manifest inside must carry
 * the same id and version. Nothing is installed.
 */
export async function fetchVerifiedPackage(deps: RemoteDeps, req: RemoteRequest): Promise<VerifiedPackage> {
  if (typeof req.id !== 'string' || req.id === '') throw new PluginError('id is required');
  if (req.version !== undefined && req.version !== null && typeof req.version !== 'string') throw new PluginError('version must be a string');
  const { plugins } = await fetchRegistry(deps, req.registryUrl);
  const entry = plugins.find((p) => p.id === req.id);
  if (!entry) throw new PluginError(`The registry has no plugin "${req.id}"`, 404);
  const wanted = (req.version as string | undefined | null) || entry.latest;
  const version = entry.versions.find((v) => v.version === wanted);
  if (!version) throw new PluginError(`The registry has no version ${wanted} of ${entry.id}`, 404);

  const zip = await fetchGuarded(deps, version.zip, { maxBytes: MAX_PACKAGE_BYTES, timeoutMs: PACKAGE_TIMEOUT_MS, what: 'The plugin package' });
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== version.sha256) {
    throw new PluginError(`Checksum mismatch for ${entry.id}@${version.version}: the registry lists ${version.sha256} but the download is ${actual}. Nothing was installed.`, 422);
  }

  const manifest = readZipManifest(zip); // throws PluginError 400 on a bad package
  if (manifest.id !== entry.id || manifest.version !== version.version) {
    throw new PluginError(`The package is ${manifest.id}@${manifest.version}, not the ${entry.id}@${version.version} the registry listed. Nothing was installed.`, 422);
  }
  return { zip, entry, version, manifest };
}

/** What an admin should see before confirming an install, read from the verified zip's manifest. */
export function previewOf(pkg: VerifiedPackage) {
  const { manifest, version } = pkg;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage ?? null,
    category: manifest.category,
    permissions: manifest.permissions ?? [],
    services: manifest.services ?? [],
    hasServer: manifest.server !== undefined,
    hasWeb: manifest.web !== undefined,
    publicRoutes: manifest.public ?? [],
    sha256: version.sha256,
    size: pkg.zip.byteLength,
  };
}

export async function installRemote(runtime: PluginRuntime, deps: RemoteDeps, req: RemoteRequest): Promise<InstalledPackage> {
  const pkg = await fetchVerifiedPackage(deps, req);
  return runtime.installPackage(pkg.zip, 'repository');
}
