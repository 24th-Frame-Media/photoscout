// Bundles the plugin's two halves and packs them with plugin.json into
// dist/<id>-<version>.zip, the package the host installs. The zip has all three
// files at its root:
//   server.js  from src/server.ts  (Node, every import inlined)
//   web.js     from src/web.ts     (browser ES module the SPA import()s; it imports
//                                   only types from the app, and React comes from
//                                   host.ui.react, so nothing is external or bundled in)
//   plugin.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestBytes = fs.readFileSync(path.join(here, 'plugin.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const dist = path.join(here, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/server.ts')],
  outfile: path.join(dist, 'server.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: [],
  legalComments: 'none',
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(here, 'src/web.ts')],
  outfile: path.join(dist, 'web.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: [],
  legalComments: 'none',
  logLevel: 'warning',
});

const files = { 'plugin.json': manifestBytes, 'server.js': fs.readFileSync(path.join(dist, 'server.js')) };
if (manifest.web) {
  // The manifest names the file the SPA will load; it must be in the package.
  const webPath = path.join(dist, manifest.web);
  if (!fs.existsSync(webPath)) throw new Error(`plugin.json "web" is ${manifest.web}, but the build produced no such file`);
  files[manifest.web] = fs.readFileSync(webPath);
}
const zip = zipSync(files, { level: 9 });
const zipPath = path.join(dist, `${manifest.id}-${manifest.version}.zip`);
fs.writeFileSync(zipPath, zip);
console.log(`built ${path.relative(here, zipPath)} (${zip.byteLength} bytes; ${Object.keys(files).join(', ')})`);
