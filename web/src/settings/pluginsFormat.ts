import type { PluginLogEntry, PluginPermission, PluginService, PluginSettingField, PluginStatus, PluginSource } from './pluginsApi.js';

/**
 * The plain-English parts of the Plugins page: what a permission means, which
 * badge a plugin gets, and how a settings form turns into the values the server
 * takes. No React here, so these can be tested on their own.
 */

export const SAFE_MODE_MESSAGE = 'Safe mode: all plugins are off. Remove PHOTOSCOUT_SAFE_MODE to turn them back on.';
export const RESTART_MESSAGE = 'Several plugins were updated since the last restart. Restart PhotoScout when convenient to free memory.';

const CATEGORY_LABELS: Record<string, string> = {
  map: 'Map layer',
  feed: 'Feed',
  events: 'Events',
  ai: 'AI',
  tools: 'Tools',
};

export function categoryLabel(category: string | null): string {
  if (!category) return 'Plugin';
  return CATEGORY_LABELS[category] ?? category;
}

/** What a declared permission means to someone who is not a developer. */
export function permissionWords(p: PluginPermission): string {
  const detail = p.detail?.trim();
  switch (p.kind) {
    case 'network':
      return detail ? `Connects to ${detail}` : 'Connects to other websites';
    case 'secrets':
      return 'Stores passwords or keys';
    case 'realtime':
      return 'Sends live updates';
    case 'llm':
      return 'Uses AI models';
    case 'tasks':
      return 'Runs scheduled tasks';
    case 'storage':
      return 'Stores its own data';
    default:
      return `Asks for access it does not describe (${String(p.kind)})`;
  }
}

/** One line per distinct permission, in the order the plugin declared them. */
export function permissionLines(permissions: PluginPermission[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of permissions) {
    const line = permissionWords(p);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** "Needs a companion service: name (image)", or null when there are none. */
export function servicesLine(services: PluginService[]): string | null {
  if (services.length === 0) return null;
  const parts = services.map((s) => `${s.name} (${s.image})`);
  return `Needs a companion service: ${parts.join(', ')}`;
}

export type BadgeTone = 'ok' | 'off' | 'error' | 'muted';

/** The status badge: Active, Error, Off (switched off), or Not running (on, but not started, e.g. in safe mode). */
export function statusBadge(p: Pick<PluginStatus, 'status' | 'enabled'>): { label: string; tone: BadgeTone } {
  if (p.status === 'active') return { label: 'Active', tone: 'ok' };
  if (p.status === 'error') return { label: 'Error', tone: 'error' };
  if (!p.enabled || p.status === 'disabled') return { label: 'Off', tone: 'off' };
  return { label: 'Not running', tone: 'muted' };
}

/** The small tag beside the status: where the plugin came from. Uploads carry no tag. */
export function originTag(source: PluginSource): { label: string; title: string } | null {
  if (source === 'bundled') return { label: 'Bundled', title: 'Ships with PhotoScout and updates with it' };
  if (source === 'dev') return { label: 'Dev', title: 'Loaded from a development folder' };
  if (source === 'repository') return { label: 'Registry', title: 'Installed from a plugin registry' };
  return null;
}

export function rollbackLabel(previousVersion: string | null): string | null {
  return previousVersion ? `Roll back to ${previousVersion}` : null;
}

/** A file inside an installed version, as the server serves it: /plugins/<id>/<version>/<path>. */
export function pluginFileUrl(id: string, version: string, relPath: string): string {
  const path = relPath.split('/').map(encodeURIComponent).join('/');
  return `/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${path}`;
}

export function iconUrl(p: Pick<PluginStatus, 'id' | 'version' | 'icon'>): string | null {
  return p.icon ? pluginFileUrl(p.id, p.version, p.icon) : null;
}

/** The server records log lines oldest first; the page shows the newest at the top. */
export function newestFirst(entries: PluginLogEntry[]): PluginLogEntry[] {
  return [...entries].reverse();
}

// --- registries -----------------------------------------------------------------

/**
 * Compare two plain semver versions (1.2.3, 1.2.3-rc.1, build metadata ignored).
 * Negative when `a` is older than `b`, positive when newer, 0 when they are the same.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release outranks a pre-release of the same numbers.
  if (x.pre.length === 0 || y.pre.length === 0) return (x.pre.length === 0 ? 1 : 0) - (y.pre.length === 0 ? 1 : 0);
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (pNum !== qNum) {
      return pNum ? -1 : 1; // numeric identifiers sort before text ones
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

function parseSemver(version: string): { core: number[]; pre: string[] } {
  const noBuild = version.split('+')[0];
  const dash = noBuild.indexOf('-');
  const core = (dash < 0 ? noBuild : noBuild.slice(0, dash)).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pre = dash < 0 ? [] : noBuild.slice(dash + 1).split('.');
  return { core, pre };
}

/** What a registry card offers: install it, update the copy installed, or nothing (already at the latest or newer). */
export function registryStatus(latest: string, installedVersion: string | null): 'install' | 'update' | 'current' {
  if (installedVersion === null) return 'install';
  return compareVersions(installedVersion, latest) < 0 ? 'update' : 'current';
}

/**
 * The link target for a text the registry supplied (a homepage), or null. A registry is not trusted to
 * supply a javascript: or other non-web link, so only http and https survive.
 */
export function safeHttpUrl(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  return isHttpUrl(trimmed) ? trimmed : null;
}

/** A byte count for a person: "812 B", "240 KB", "1.5 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- settings forms -------------------------------------------------------------

/** What a field's input holds while it is being edited. Secrets are typed fresh, never shown back. */
export type DraftValue = string | boolean;

/** The starting input value for a field, from the server's effective value (stored, or the default). */
export function draftFor(field: PluginSettingField, value: unknown): DraftValue {
  if (field.type === 'boolean') return value === true;
  if (field.type === 'secret') return '';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

export type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

/** Turn one input into the value the server expects, or say what is wrong with it. Secrets are handled by changedSettings. */
export function coerceSettingValue(field: PluginSettingField, raw: DraftValue): Coerced {
  const label = field.label;
  switch (field.type) {
    case 'boolean':
      return { ok: true, value: raw === true };
    case 'number': {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') return { ok: false, error: field.required ? `${label} is required` : `${label} needs a number` };
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `${label} needs a number` };
      if (field.min !== undefined && n < field.min) return { ok: false, error: `${label} must be at least ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `${label} must be at most ${field.max}` };
      return { ok: true, value: n };
    }
    case 'select': {
      const text = typeof raw === 'string' ? raw : '';
      if (!field.options.some((o) => o.value === text)) return { ok: false, error: `${label} is not one of the choices` };
      return { ok: true, value: text };
    }
    case 'url': {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') return field.required ? { ok: false, error: `${label} is required` } : { ok: true, value: '' };
      if (!isHttpUrl(text)) return { ok: false, error: `${label} must be an http or https address` };
      return { ok: true, value: text };
    }
    case 'string':
    case 'secret':
    default: {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '' && field.required) return { ok: false, error: `${label} is required` };
      return { ok: true, value: text };
    }
  }
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface SettingsEdits {
  /** The inputs of the ordinary fields. */
  values: Record<string, DraftValue>;
  /** What was typed into each secret field. Blank means "keep the stored one". */
  secretTyped: Record<string, string>;
  /** Secrets the admin asked to remove. */
  secretRemoved: Record<string, boolean>;
  /** The server's effective values, to tell what actually changed. */
  current: Record<string, unknown>;
}

/**
 * The body for PUT settings: only what changed. A secret left blank is not
 * sent (the stored one stays), one typed is sent, and one removed is sent as null.
 */
export function changedSettings(fields: PluginSettingField[], edits: SettingsEdits): { payload: Record<string, unknown>; errors: string[] } {
  const payload: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const field of fields) {
    if (field.type === 'secret') {
      if (edits.secretRemoved[field.key]) {
        payload[field.key] = null;
      } else {
        const typed = (edits.secretTyped[field.key] ?? '').trim();
        if (typed !== '') payload[field.key] = typed;
      }
      continue;
    }
    // Only a field the admin touched is checked and sent: an untouched one is left as it is on the server.
    const raw = edits.values[field.key];
    if (raw === undefined || raw === draftFor(field, edits.current[field.key])) continue;
    const result = coerceSettingValue(field, raw);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    payload[field.key] = result.value;
  }
  return { payload, errors };
}
