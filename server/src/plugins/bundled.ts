import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { readZipManifest, type PluginStore } from './store.js';

/**
 * Plugins that ship with the app: the packages built from plugins/* in the
 * repository, or copied into /app/bundled-plugins in the image.
 *
 * At startup each zip is installed with source `bundled` when its id is not
 * installed yet, and upgraded when it is newer than the installed bundled copy.
 * The admin's choices always win:
 *   - an id installed from an upload or a repository is left alone;
 *   - a plugin the admin disabled stays disabled (the upgrade keeps the flag);
 *   - a version the admin rolled back from is not put back until a newer one ships.
 *
 * Install only: the caller starts plugins afterwards with loadAll().
 */

export interface BundledReport {
  /** "id@version" for each new install. */
  installed: string[];
  /** "id@version" for each upgrade of an installed bundled copy. */
  upgraded: string[];
  /** Left as they are on purpose, with the reason. */
  kept: { file: string; reason: string }[];
  /** Could not be read or installed. */
  failed: { file: string; reason: string }[];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Install or upgrade every plugin zip in `dir`. Never throws; each zip's outcome is in the report. */
export function installBundled(dir: string, store: PluginStore): BundledReport {
  const report: BundledReport = { installed: [], upgraded: [], kept: [], failed: [] };
  if (!isDir(dir)) return report;
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.zip')).sort();

  for (const file of files) {
    try {
      const zip = new Uint8Array(fs.readFileSync(path.join(dir, file)));
      const { id, version } = readZipManifest(zip);
      const row = store.get(id);

      if (!row) {
        store.installFromZip(zip, { source: 'bundled' });
        report.installed.push(`${id}@${version}`);
        continue;
      }
      if (row.source !== 'bundled') {
        report.kept.push({ file, reason: `${id} was installed by an admin; the bundled copy is not used` });
        continue;
      }
      // The usual case on every start (same version): nothing to do, and nothing to report.
      if (!semver.gt(version, row.activeVersion)) continue;
      if (row.previousVersion === version) {
        report.kept.push({ file, reason: `an admin rolled ${id} back from ${version}; not put back until a newer version ships` });
        continue;
      }
      store.installFromZip(zip, { source: 'bundled' });
      store.prune(id);
      report.upgraded.push(`${id}@${version}`);
    } catch (err) {
      report.failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** The repository or image root: server/src/plugins and server/dist/plugins are both three levels below it. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where bundled zips are looked for. PHOTOSCOUT_BUNDLED_PLUGINS, when set, is the
 * only folder. Otherwise: each plugins/<name>/dist (development) and
 * bundled-plugins/ (the image), whichever exist.
 */
export function bundledDirs(env: NodeJS.ProcessEnv = process.env, appRoot: string = APP_ROOT): string[] {
  const override = env.PHOTOSCOUT_BUNDLED_PLUGINS?.trim();
  if (override) return [path.resolve(override)];
  const dirs: string[] = [];
  const pluginsRoot = path.join(appRoot, 'plugins');
  if (isDir(pluginsRoot)) {
    for (const name of fs.readdirSync(pluginsRoot).sort()) dirs.push(path.join(pluginsRoot, name, 'dist'));
  }
  dirs.push(path.join(appRoot, 'bundled-plugins'));
  return dirs.filter(isDir);
}
