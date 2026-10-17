import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import semver from 'semver';
import { collectDir, MAX_PACKAGE_BYTES, stripSingleFolder, unpackZip, writeStage } from './archive.js';
import { parseManifest, PLUGIN_ID_PATTERN, PluginError } from './manifest.js';
import type { PluginManifest } from './types.js';

/**
 * Where plugins live on disk and what the host remembers about them.
 *
 *   <root>/<id>/<version>/   the extracted package (plugin.json, server.js, ...)
 *   <root>/<id>/data/        the plugin's own files, including plugin.db
 *
 * The `plugins` table in the main database says which version is active, which
 * one a rollback would return to, and whether the plugin is switched on. Only
 * the active and the previous version are kept on disk.
 */

export type PluginSource = 'upload' | 'dev' | 'bundled' | 'repository';

export interface PluginRow {
  id: string;
  enabled: boolean;
  activeVersion: string;
  previousVersion: string | null;
  settings: Record<string, unknown>;
  status: string;
  lastError: string;
  source: PluginSource;
  installedAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  enabled: number;
  active_version: string;
  previous_version: string | null;
  settings_json: string;
  status: string;
  last_error: string;
  source: string;
  installed_at: string;
  updated_at: string;
}

export interface InstallResult {
  manifest: PluginManifest;
  /** The row as it was before this install, or null for a first install. */
  prior: PluginRow | null;
  version: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  active_version TEXT NOT NULL,
  previous_version TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'inactive',
  last_error TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'upload',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Read and check the manifest of an extracted folder, and that the files it names are there. */
export function readManifestDir(dir: string): PluginManifest {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) throw new PluginError('The package has no plugin.json at its root');
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new PluginError('plugin.json is not valid JSON');
  }
  const manifest = parseManifest(json);
  for (const rel of [manifest.server, manifest.web, manifest.icon]) {
    if (rel && !isFile(path.join(dir, rel))) throw new PluginError(`${rel} is named in plugin.json but is not in the package`);
  }
  return manifest;
}

/** The manifest of a package, read from the zip without installing it. */
export function readZipManifest(zip: Uint8Array): PluginManifest {
  const json = stripSingleFolder(unpackZip(zip)).get('plugin.json');
  if (!json) throw new PluginError('The package has no plugin.json at its root');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(json).toString('utf8'));
  } catch {
    throw new PluginError('plugin.json is not valid JSON');
  }
  return parseManifest(parsed);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The stored settings after an upgrade. A value the outgoing version declared a
 * secret is kept only while the new version still declares it one; otherwise it
 * would show in the clear as an ordinary field, or linger after its field went.
 */
function settingsAfterUpgrade(prior: PluginRow, next: PluginManifest, priorDir: string): Record<string, unknown> {
  let wasSecret: string[] = [];
  try {
    wasSecret = (readManifestDir(priorDir).settings ?? []).filter((f) => f.type === 'secret').map((f) => f.key);
  } catch {
    // The outgoing folder is unreadable: nothing to compare against.
  }
  const stillSecret = new Set((next.settings ?? []).filter((f) => f.type === 'secret').map((f) => f.key));
  const kept = { ...prior.settings };
  for (const key of wasSecret) {
    if (!stillSecret.has(key)) delete kept[key];
  }
  return kept;
}

export interface PluginStore {
  readonly root: string;
  assertId(id: string): void;
  versionDir(id: string, version: string): string;
  dataDir(id: string): string;
  list(): PluginRow[];
  get(id: string): PluginRow | null;
  installFromZip(zip: Uint8Array, opts: { source: PluginSource }): InstallResult;
  installFromDir(dir: string, opts: { source: PluginSource }): InstallResult;
  /** A dev-mode row: created if missing, its version follows the dev folder when it is a dev row. */
  ensureDevRow(manifest: PluginManifest): PluginRow;
  /** The installed version's folder, if that version is still on disk (active or previous only). */
  resolveVersionDir(id: string, version: string): string | null;
  /** Swap the active and previous versions. Returns the row after the swap. */
  rollback(id: string): PluginRow;
  /** Undo a failed install: the prior row comes back, and the new version folder goes. */
  revertInstall(id: string, prior: PluginRow | null, version: string): void;
  /** Remove version folders other than the active and previous one. */
  prune(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  setStatus(id: string, status: string, lastError: string): void;
  saveSettings(id: string, values: Record<string, unknown>): void;
  uninstall(id: string, opts: { keepData: boolean }): void;
}

function rowOf(raw: RawRow): PluginRow {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.settings_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    settings = {};
  }
  return {
    id: raw.id,
    enabled: raw.enabled === 1,
    activeVersion: raw.active_version,
    previousVersion: raw.previous_version,
    settings,
    status: raw.status,
    lastError: raw.last_error,
    source: raw.source as PluginSource,
    installedAt: raw.installed_at,
    updatedAt: raw.updated_at,
  };
}

export function createPluginStore(opts: { handle: DatabaseSync; root: string }): PluginStore {
  const { handle } = opts;
  const root = path.resolve(opts.root);
  fs.mkdirSync(root, { recursive: true });
  handle.exec(SCHEMA);

  const assertId = (id: string): void => {
    if (id.length > 100 || !PLUGIN_ID_PATTERN.test(id)) throw new PluginError(`"${id}" is not a valid plugin id`, 400);
  };
  const assertVersion = (version: string): void => {
    if (!semver.valid(version)) throw new PluginError(`"${version}" is not a valid version`, 400);
  };
  const versionDir = (id: string, version: string): string => {
    assertId(id);
    assertVersion(version);
    return path.join(root, id, version);
  };
  const dataDir = (id: string): string => {
    assertId(id);
    return path.join(root, id, 'data');
  };
  const pluginFolder = (id: string): string => {
    assertId(id);
    return path.join(root, id);
  };

  function get(id: string): PluginRow | null {
    const raw = handle.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as RawRow | undefined;
    return raw ? rowOf(raw) : null;
  }

  function list(): PluginRow[] {
    return (handle.prepare('SELECT * FROM plugins ORDER BY id').all() as unknown as RawRow[]).map(rowOf);
  }

  function stagingDir(): string {
    return path.join(root, `.staging-${crypto.randomUUID()}`);
  }

  /** Move a checked, staged package into its version folder and record it. */
  function place(stage: string, manifest: PluginManifest, source: PluginSource): InstallResult {
    const { id, version } = manifest;
    const prior = get(id);
    if (prior && (prior.activeVersion === version || prior.previousVersion === version)) {
      throw new PluginError(`Version ${version} is already installed; bump the version in plugin.json`, 409);
    }
    const dest = versionDir(id, version);
    fs.mkdirSync(pluginFolder(id), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);

    const now = new Date().toISOString();
    if (prior) {
      const settings = settingsAfterUpgrade(prior, manifest, versionDir(id, prior.activeVersion));
      handle
        .prepare('UPDATE plugins SET active_version = ?, previous_version = ?, source = ?, settings_json = ?, updated_at = ? WHERE id = ?')
        .run(version, prior.activeVersion, source, JSON.stringify(settings), now, id);
    } else {
      handle
        .prepare(`INSERT INTO plugins (id, enabled, active_version, previous_version, settings_json, status, last_error, source, installed_at, updated_at)
                  VALUES (?, 1, ?, NULL, '{}', 'inactive', '', ?, ?, ?)`)
        .run(id, version, source, now, now);
    }
    return { manifest, prior, version };
  }

  function installStaged(files: Map<string, Uint8Array>, source: PluginSource): InstallResult {
    const stage = stagingDir();
    try {
      writeStage(stage, files);
      const manifest = readManifestDir(stage);
      return place(stage, manifest, source);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  return {
    root,
    assertId,
    versionDir,
    dataDir,
    list,
    get,

    installFromZip(zip, opts) {
      if (zip.byteLength > MAX_PACKAGE_BYTES) throw new PluginError('The package is larger than 50 MB', 413);
      return installStaged(stripSingleFolder(unpackZip(zip)), opts.source);
    },

    installFromDir(dir, opts) {
      return installStaged(stripSingleFolder(collectDir(dir)), opts.source);
    },

    ensureDevRow(manifest) {
      const now = new Date().toISOString();
      const row = get(manifest.id);
      if (!row) {
        handle
          .prepare(`INSERT INTO plugins (id, enabled, active_version, previous_version, settings_json, status, last_error, source, installed_at, updated_at)
                    VALUES (?, 1, ?, NULL, '{}', 'inactive', '', 'dev', ?, ?)`)
          .run(manifest.id, manifest.version, now, now);
      } else if (row.source === 'dev' && row.activeVersion !== manifest.version) {
        handle.prepare('UPDATE plugins SET active_version = ?, updated_at = ? WHERE id = ?').run(manifest.version, now, manifest.id);
      }
      return get(manifest.id)!;
    },

    resolveVersionDir(id, version) {
      const row = get(id);
      if (!row || (row.activeVersion !== version && row.previousVersion !== version)) return null;
      const dir = versionDir(id, version);
      return isFile(path.join(dir, 'plugin.json')) ? dir : null;
    },

    rollback(id) {
      const row = get(id);
      if (!row) throw new PluginError('Plugin is not installed', 404);
      if (!row.previousVersion) throw new PluginError('There is no earlier version to roll back to', 409);
      if (!isDir(versionDir(id, row.previousVersion))) throw new PluginError(`Version ${row.previousVersion} is no longer on disk`, 409);
      handle
        .prepare('UPDATE plugins SET active_version = ?, previous_version = ?, updated_at = ? WHERE id = ?')
        .run(row.previousVersion, row.activeVersion, new Date().toISOString(), id);
      return get(id)!;
    },

    revertInstall(id, prior, version) {
      fs.rmSync(versionDir(id, version), { recursive: true, force: true });
      if (prior) {
        // The settings come back too: the upgrade may have dropped a secret the failed version did not keep.
        handle
          .prepare('UPDATE plugins SET active_version = ?, previous_version = ?, settings_json = ?, updated_at = ? WHERE id = ?')
          .run(prior.activeVersion, prior.previousVersion, JSON.stringify(prior.settings), new Date().toISOString(), id);
      } else {
        handle.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      }
    },

    prune(id) {
      const row = get(id);
      if (!row || !isDir(pluginFolder(id))) return;
      const keep = new Set([row.activeVersion, row.previousVersion].filter((v): v is string => Boolean(v)));
      for (const name of fs.readdirSync(pluginFolder(id))) {
        if (name === 'data' || keep.has(name) || !semver.valid(name)) continue;
        fs.rmSync(path.join(pluginFolder(id), name), { recursive: true, force: true });
      }
    },

    setEnabled(id, enabled) {
      handle.prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, new Date().toISOString(), id);
    },

    setStatus(id, status, lastError) {
      handle
        .prepare('UPDATE plugins SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(status, lastError, new Date().toISOString(), id);
    },

    saveSettings(id, values) {
      handle.prepare('UPDATE plugins SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(values), new Date().toISOString(), id);
    },

    uninstall(id, opts) {
      const row = get(id);
      if (!row) throw new PluginError('Plugin is not installed', 404);
      handle.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      // A dev folder belongs to the developer, not to the host: nothing under root to remove.
      if (row.source === 'dev' || !isDir(pluginFolder(id))) return;
      for (const name of fs.readdirSync(pluginFolder(id))) {
        if (name === 'data') continue;
        fs.rmSync(path.join(pluginFolder(id), name), { recursive: true, force: true });
      }
      if (!opts.keepData) fs.rmSync(pluginFolder(id), { recursive: true, force: true });
    },
  };
}
