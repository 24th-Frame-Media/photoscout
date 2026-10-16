// Builds this plugin into dist/<id>-<version>.zip by running the repository's plugin
// CLI (scripts/plugin.mjs). The CLI is found by walking up from this folder, so this
// works from docs/plugins/template and from plugins/<name> alike.
// Same as, from the repository root: npm run plugin:build -- <this folder>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let root = here;
while (!fs.existsSync(path.join(root, 'scripts', 'plugin.mjs'))) {
  const up = path.dirname(root);
  if (up === root) {
    console.error('build.mjs: cannot find scripts/plugin.mjs in any parent folder');
    process.exit(1);
  }
  root = up;
}
const cli = path.join(root, 'scripts', 'plugin.mjs');
const result = spawnSync(process.execPath, [cli, 'build', here], { stdio: 'inherit' });
process.exit(result.status ?? 1);
