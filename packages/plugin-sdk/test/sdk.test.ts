import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sdk from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.resolve(here, '..');
const REPO = path.resolve(SDK_DIR, '..', '..');
const TEMPLATE = path.join(REPO, 'docs', 'plugins', 'template');
const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8')) as { version: string };

// The CLI is plain .mjs with no declaration file, so it is loaded through this typed view.
interface SdkCheck {
  dir: string;
  version: string | null;
  errors: { file: string; message: string }[];
  written: string[];
}
interface PluginCli {
  checkPluginSdk(dir: string, opts?: { sdkRoot?: string; write?: boolean }): SdkCheck;
  sdkDrift(have: string, want: string, version: string): string | null;
}
const cli = (await import(pathToFileURL(path.join(REPO, 'scripts', 'plugin.mjs')).href)) as PluginCli;

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway plugin folder holding a copy of the template's vendored contract. */
function scratchPlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sdk-test-'));
  scratchDirs.push(dir);
  fs.cpSync(path.join(TEMPLATE, 'src', 'sdk'), path.join(dir, 'src', 'sdk'), { recursive: true });
  return dir;
}

describe('@photoscout/plugin-sdk entry points', () => {
  it('re-exports the version constants at the top level and in their namespaces', () => {
    assert.equal(sdk.WEB_API_VERSION, sdk.web.WEB_API_VERSION);
    assert.equal(sdk.HOST_API_VERSION, sdk.server.HOST_API_VERSION);
    assert.match(sdk.WEB_API_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(sdk.HOST_API_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('definePlugin returns its argument in both halves', () => {
    const web = { activate() {} };
    const server = { activate() {} };
    assert.equal(sdk.web.definePlugin(web), web);
    assert.equal(sdk.server.definePlugin(server), server);
  });
});

describe('vendored contract copies (plugin.mjs sdk-check)', () => {
  it('the template copies in docs/plugins/template match the SDK source', () => {
    const result = cli.checkPluginSdk(TEMPLATE, { sdkRoot: REPO });
    assert.deepEqual(result.errors, []);
    assert.equal(result.version, pkg.version);
  });

  it('a copy with one edited line is reported with the line and the SDK text', () => {
    const dir = scratchPlugin();
    const file = path.join(dir, 'src', 'sdk', 'web-api.ts');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace("WEB_API_VERSION = '2.0.0'", "WEB_API_VERSION = '2.0.1'"));
    const result = cli.checkPluginSdk(dir, { sdkRoot: REPO });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, 'src/sdk/web-api.ts');
    assert.match(result.errors[0].message, /differs from the SDK at line \d+ \(the SDK has ".*WEB_API_VERSION = '2\.0\.0';/);
  });

  it('a copy that records another SDK version is reported as a version mismatch', () => {
    const dir = scratchPlugin();
    const file = path.join(dir, 'src', 'sdk', 'server-api.ts');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(`@photoscout/plugin-sdk ${pkg.version} (src/server.ts)`, '@photoscout/plugin-sdk 1.0.0 (src/server.ts)'));
    const result = cli.checkPluginSdk(dir, { sdkRoot: REPO });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, 'src/sdk/server-api.ts');
    assert.match(result.errors[0].message, new RegExp(`is a copy of @photoscout/plugin-sdk 1\\.0\\.0; the SDK is ${pkg.version.replaceAll('.', '\\.')}`));
  });

  it('a missing copy is reported', () => {
    const dir = scratchPlugin();
    fs.rmSync(path.join(dir, 'src', 'sdk', 'server-api.ts'));
    const result = cli.checkPluginSdk(dir, { sdkRoot: REPO });
    assert.deepEqual(result.errors.map((e) => e.file), ['src/sdk/server-api.ts']);
    assert.match(result.errors[0].message, /is missing/);
  });

  it('--write re-copies a drifted copy, and the next check passes', () => {
    const dir = scratchPlugin();
    const file = path.join(dir, 'src', 'sdk', 'web-api.ts');
    fs.writeFileSync(file, '// hand edit\n' + fs.readFileSync(file, 'utf8'));
    const written = cli.checkPluginSdk(dir, { sdkRoot: REPO, write: true });
    assert.deepEqual(written.written, ['src/sdk/web-api.ts', 'src/sdk/server-api.ts']);
    assert.deepEqual(cli.checkPluginSdk(dir, { sdkRoot: REPO }).errors, []);
    const body = fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n');
    assert.equal(body, fs.readFileSync(path.join(SDK_DIR, 'src', 'web.ts'), 'utf8'));
  });

  it('line endings do not count as drift', () => {
    const dir = scratchPlugin();
    const file = path.join(dir, 'src', 'sdk', 'web-api.ts');
    // Normalise first: the checkout may already hold CRLF, and a bare \n -> \r\n would double the \r.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.deepEqual(cli.checkPluginSdk(dir, { sdkRoot: REPO }).errors, []);
    assert.equal(cli.sdkDrift('a\r\nb\r\n', 'a\nb\n', pkg.version), null);
  });
});
