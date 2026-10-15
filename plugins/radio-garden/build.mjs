// Bundles src/server.ts into dist/server.js (one self-contained ESM file, every
// import inlined) and packs it with plugin.json into dist/<id>-<version>.zip,
// the package the host installs. The zip has both files at its root.
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

const serverBytes = fs.readFileSync(path.join(dist, 'server.js'));
const zip = zipSync({ 'plugin.json': manifestBytes, 'server.js': serverBytes }, { level: 9 });
const zipPath = path.join(dist, `${manifest.id}-${manifest.version}.zip`);
fs.writeFileSync(zipPath, zip);
console.log(`built ${path.relative(here, zipPath)} (${zip.byteLength} bytes)`);
