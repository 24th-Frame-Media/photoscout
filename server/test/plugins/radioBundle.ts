import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { zipSync } from 'fflate';

/**
 * The Radio Garden plugin as an installable package, built here from its
 * source the way plugins/radio-garden/build.mjs builds it, so these tests do
 * not need a prior build. The bundle must be self-contained: esbuild inlines
 * every import, and this package's server.js is what the host loads.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RADIO_PLUGIN_DIR = path.join(REPO, 'plugins', 'radio-garden');
export const RADIO_PLUGIN_ID = 'media.24thframe.radio-garden';

/** The radio plugin's zip: plugin.json, server.js and web.js at its root. */
export function radioPluginZip(): Uint8Array {
  const bundle = buildSync({
    entryPoints: [path.join(RADIO_PLUGIN_DIR, 'src', 'server.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [],
    logLevel: 'silent',
  });
  const serverJs = bundle.outputFiles[0].contents;
  const web = buildSync({
    entryPoints: [path.join(RADIO_PLUGIN_DIR, 'src', 'web.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: [],
    logLevel: 'silent',
  });
  const manifest = fs.readFileSync(path.join(RADIO_PLUGIN_DIR, 'plugin.json'));
  return zipSync({ 'plugin.json': manifest, 'server.js': serverJs, 'web.js': web.outputFiles[0].contents });
}

/** A folder under `parent` holding the radio zip, as plugins/radio-garden/dist does after a build. */
export function radioBundleDir(parent: string): string {
  const dir = path.join(parent, 'bundled');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${RADIO_PLUGIN_ID}-1.0.0.zip`), radioPluginZip());
  return dir;
}
