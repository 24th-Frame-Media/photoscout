#!/usr/bin/env node
/**
 * PhotoScout plugin CLI: check a plugin folder, or build its package.
 *
 *   node scripts/plugin.mjs validate <dir> [<dir> ...] [--json]
 *   node scripts/plugin.mjs build <dir> [--json]
 *
 * validate  Reads <dir>/plugin.json and checks it three ways: against
 *           docs/plugins/plugin.schema.json, against the host's own
 *           parseManifest (server/src/plugins/manifest.ts, bundled here), and
 *           that every file it names exists or can be built from src/.
 *           Writes nothing.
 * build     Runs validate, then bundles src/server.ts -> server.js and
 *           src/web.ts -> web.js with esbuild, copies the icon and assets/,
 *           checks that each bundle default-exports an object with activate(),
 *           and writes dist/<id>-<version>.zip. It reads the zip back and runs
 *           the host check on it before the build counts as done.
 *
 * Exit status: 0 ok, 1 the plugin has errors or the build failed, 2 bad usage.
 * Dependencies: esbuild and fflate, resolved from the repository root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT, 'docs', 'plugins', 'plugin.schema.json');
const HOST_MANIFEST = path.join(ROOT, 'server', 'src', 'plugins', 'manifest.ts');
const SOURCE_EXTENSIONS = ['.ts', '.mjs', '.js'];
const USAGE = `usage:
  node scripts/plugin.mjs validate <dir> [<dir> ...] [--json]
  node scripts/plugin.mjs build <dir> [--json]`;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const pointer = (base, key) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// ---------------------------------------------------------------------------
// A small JSON Schema checker: the keyword subset plugin.schema.json uses.
// Keywords outside this set throw, so a schema edit that needs more is loud.
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const',
  'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength',
  'maxLength', 'pattern', 'minimum', 'maximum', 'oneOf', 'anyOf', 'not',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function isType(want, value) {
  if (want === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (want === 'object') return isObject(value);
  return typeOf(value) === want;
}

function resolveRef(ref, root) {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  const target = m ? root.$defs?.[m[1]] : undefined;
  if (!target) throw new Error(`schema bug: cannot resolve $ref ${ref}`);
  return target;
}

function collect(schema, value, at, root) {
  const out = [];
  checkNode(schema, value, at, root, out);
  return out;
}

/** The branch to blame when no oneOf/anyOf branch matches: the one whose "type" property accepts the value's "type", else the closest. */
function pickBranch(branches, value) {
  let pool = branches;
  const tag = isObject(value) ? value.type : undefined;
  if (tag !== undefined) {
    const tagged = branches.filter(({ s }) => {
      const p = s.properties?.type;
      if (p === undefined) return false;
      if (p.enum !== undefined) return p.enum.includes(tag);
      if (p.const !== undefined) return p.const === tag;
      return true;
    });
    if (tagged.length > 0) pool = tagged;
  }
  return pool.reduce((best, b) => (b.errs.length < best.errs.length ? b : best));
}

function checkNode(schema, value, at, root, out) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`schema bug: keyword "${key}" is not supported by scripts/plugin.mjs`);
  }
  const fail = (message, where = at) => out.push({ path: where, message });
  if (schema.$ref !== undefined) checkNode(resolveRef(schema.$ref, root), value, at, root, out);

  if (schema.type !== undefined) {
    const wanted = [].concat(schema.type);
    if (!wanted.some((t) => isType(t, value))) {
      fail(`must be ${wanted.join(' or ')}, not ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    fail(`must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`must be at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      fail(`has the wrong format: ${schema.description ?? `must match ${schema.pattern}`}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`has at most ${schema.maxItems} item(s)`);
    if (schema.items !== undefined) value.forEach((item, i) => checkNode(schema.items, item, pointer(at, i), root, out));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail('is required', pointer(at, key));
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) checkNode(sub, value[key], pointer(at, key), root, out);
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(props, key)) continue;
        if (schema.additionalProperties === false) fail('is not a known field', pointer(at, key));
        else if (isObject(schema.additionalProperties)) checkNode(schema.additionalProperties, value[key], pointer(at, key), root, out);
      }
    }
  }
  if (schema.not !== undefined && collect(schema.not, value, at, root).length === 0) {
    fail(schema.not.enum ? `must not be one of ${schema.not.enum.join(', ')}` : 'is not allowed');
  }
  if (schema.oneOf !== undefined) {
    const branches = schema.oneOf.map((s) => ({ s, errs: collect(s, value, at, root) }));
    const passing = branches.filter((b) => b.errs.length === 0).length;
    if (passing === 0) out.push(...pickBranch(branches, value).errs);
    else if (passing > 1) fail('matches more than one allowed shape');
  }
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((s) => ({ s, errs: collect(s, value, at, root) }));
    if (!branches.some((b) => b.errs.length === 0)) out.push(...pickBranch(branches, value).errs);
  }
}

/** Schema errors as [{ path, message }]; path is a JSON pointer ("" for the whole document). */
export function validateAgainstSchema(schema, value) {
  return collect(schema, value, '', schema);
}

let schemaCache;
function loadSchema() {
  schemaCache ??= JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return schemaCache;
}

// ---------------------------------------------------------------------------
// The host's own checks, bundled from server/src/plugins/manifest.ts so the
// CLI cannot drift from what the server accepts.
// ---------------------------------------------------------------------------

let hostParse;
export async function loadHostParser() {
  if (hostParse) return hostParse;
  const bundled = await esbuild({
    entryPoints: [HOST_MANIFEST],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  const url = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`;
  const mod = await import(url);
  hostParse = mod.parseManifest;
  return hostParse;
}

async function importBundle(bytes) {
  return import(`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);
}

/** Where a bundle comes from: src/<name>.ts (or .mjs/.js) wins over a prebuilt file at the package root. */
function sourceFor(dir, rel) {
  const stem = path.basename(rel, '.js');
  for (const ext of SOURCE_EXTENSIONS) {
    const file = path.join(dir, 'src', stem + ext);
    if (isFile(file)) return { kind: 'source', file };
  }
  const prebuilt = path.join(dir, rel);
  if (isFile(prebuilt)) return { kind: 'prebuilt', file: prebuilt };
  return null;
}

function readAssets(dir, prefix = '') {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`assets/${rel} is a symbolic link; packages may not contain links`);
    if (entry.isDirectory()) {
      for (const [k, v] of readAssets(full, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(`assets/${rel}`, fs.readFileSync(full));
    }
  }
  return out;
}

/** Validate a plugin folder. Writes nothing. Returns { dir, errors, warnings, manifest, zip }. */
export async function inspect(dir) {
  const result = { dir, errors: [], warnings: [], manifest: null, zip: null };
  const error = (file, where, message) => result.errors.push({ file, path: where, message });
  const abs = path.resolve(dir);

  if (!isDir(abs)) {
    error(dir, '', 'is not a folder');
    return result;
  }
  const manifestFile = path.join(abs, 'plugin.json');
  if (!isFile(manifestFile)) {
    error('plugin.json', '', 'is missing; a plugin folder needs plugin.json at its root');
    return result;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    error('plugin.json', '', `is not valid JSON: ${err.message}`);
    return result;
  }

  const schema = loadSchema();
  const schemaErrors = validateAgainstSchema(schema, json);
  for (const e of schemaErrors) error('plugin.json', e.path, e.message);
  if (isObject(json)) {
    for (const key of Object.keys(json)) {
      if (!key.startsWith('$') && !Object.hasOwn(schema.properties, key)) {
        result.warnings.push({ file: 'plugin.json', path: pointer('', key), message: 'is not a known field; the host ignores it' });
      }
    }
  }
  if (schemaErrors.length > 0) return result;

  let manifest;
  try {
    manifest = (await loadHostParser())(json);
  } catch (err) {
    error('plugin.json', '', `host check: ${err.message}`);
    return result;
  }
  result.manifest = manifest;

  for (const key of ['server', 'web']) {
    if (manifest[key] && !sourceFor(abs, manifest[key])) {
      const stem = path.basename(manifest[key], '.js');
      error('plugin.json', `/${key}`, `"${manifest[key]}" is not in the folder, and there is no src/${stem}.ts to build it from`);
    }
  }
  if (manifest.icon && !isFile(path.join(abs, manifest.icon))) error('plugin.json', '/icon', `"${manifest.icon}" is not in the folder`);
  return result;
}

/** Validate, then bundle and zip the plugin to dist/<id>-<version>.zip. */
export async function buildPackage(dir) {
  const result = await inspect(dir);
  if (result.errors.length > 0 || !result.manifest) return result;
  const { manifest } = result;
  const abs = path.resolve(dir);

  try {
    const parse = await loadHostParser();
    const files = new Map([['plugin.json', fs.readFileSync(path.join(abs, 'plugin.json'))]]);

    for (const key of ['server', 'web']) {
      const rel = manifest[key];
      if (!rel) continue;
      const src = sourceFor(abs, rel);
      if (src.kind === 'source') {
        const server = key === 'server';
        const out = await esbuild({
          entryPoints: [src.file],
          bundle: true,
          write: false,
          format: 'esm',
          platform: server ? 'node' : 'browser',
          target: server ? 'node22' : 'es2020',
          legalComments: 'none',
          logLevel: 'silent',
        });
        files.set(rel, out.outputFiles[0].contents);
      } else {
        files.set(rel, fs.readFileSync(src.file));
      }
    }
    if (manifest.icon) files.set(manifest.icon, fs.readFileSync(path.join(abs, manifest.icon)));
    if (isDir(path.join(abs, 'assets'))) {
      for (const [name, bytes] of readAssets(path.join(abs, 'assets'))) files.set(name, bytes);
    }

    // Each bundle must load on its own and default-export an object with activate().
    for (const key of ['server', 'web']) {
      if (!manifest[key]) continue;
      let mod;
      try {
        mod = await importBundle(files.get(manifest[key]));
      } catch (err) {
        throw new Error(`${manifest[key]} does not load: ${err.message}`);
      }
      if (!isObject(mod.default) || typeof mod.default.activate !== 'function') {
        throw new Error(`${manifest[key]} must default-export an object with an activate() function`);
      }
    }

    const zipBytes = zipSync(Object.fromEntries(files), { level: 9 });

    // Read the package back the way the host does, so a bad zip is never written.
    const back = unzipSync(zipBytes);
    if (!back['plugin.json']) throw new Error('the zip has no plugin.json');
    parse(JSON.parse(Buffer.from(back['plugin.json']).toString('utf8')));
    for (const name of [manifest.server, manifest.web, manifest.icon]) {
      if (name && !back[name]) throw new Error(`${name} is missing from the zip`);
    }

    const dist = path.join(abs, 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    const zipFile = path.join(dist, `${manifest.id}-${manifest.version}.zip`);
    fs.writeFileSync(zipFile, zipBytes);
    result.zip = { file: zipFile, bytes: zipBytes.byteLength, entries: [...files.keys()] };
  } catch (err) {
    result.errors.push({ file: 'build', path: '', message: err.message });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Output and entry point
// ---------------------------------------------------------------------------

function printHuman(r) {
  const who = r.manifest ? `  (${r.manifest.id} ${r.manifest.version})` : '';
  console.log(`${r.errors.length > 0 ? 'FAILED' : 'OK'}  ${r.dir}${who}`);
  for (const e of r.errors) console.log(`  error    ${e.file}${e.path ? ` ${e.path}` : ''}: ${e.message}`);
  for (const w of r.warnings) console.log(`  warning  ${w.file}${w.path ? ` ${w.path}` : ''}: ${w.message}`);
  if (r.zip) {
    console.log(`  built    ${path.relative(process.cwd(), r.zip.file)} (${r.zip.bytes} bytes): ${r.zip.entries.join(', ')}`);
  }
  console.log(`  ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
}

function toJson(r) {
  return {
    dir: r.dir,
    ok: r.errors.length === 0,
    id: r.manifest?.id ?? null,
    version: r.manifest?.version ?? null,
    errors: r.errors,
    warnings: r.warnings,
    zip: r.zip ? { file: path.relative(ROOT, r.zip.file), bytes: r.zip.bytes, entries: r.zip.entries } : null,
  };
}

async function main(argv) {
  if (argv[0] === 'help' || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const flags = argv.filter((a) => a.startsWith('--'));
  const [cmd, ...targets] = argv.filter((a) => !a.startsWith('--'));
  const usable = flags.every((f) => f === '--json')
    && ['validate', 'build'].includes(cmd)
    && targets.length > 0
    && (cmd === 'validate' || targets.length === 1);
  if (!usable) {
    console.error(USAGE);
    return 2;
  }
  const json = flags.includes('--json');
  const results = [];
  for (const dir of targets) results.push(cmd === 'validate' ? await inspect(dir) : await buildPackage(dir));
  if (json) console.log(JSON.stringify(results.map(toJson), null, 2));
  else for (const r of results) printHuman(r);
  return results.some((r) => r.errors.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => {
    console.error(`plugin: ${err.stack || err}`);
    return 1;
  });
}
