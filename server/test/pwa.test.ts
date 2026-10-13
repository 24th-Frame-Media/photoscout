import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './httpHarness.js';

// The built web app is only there after `npm run build`; without it there is
// nothing to serve and these have nothing to say.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const built = fs.existsSync(path.join(dist, 'sw.js'));

const app = await startApp();
after(() => app.close());

test('the manifest is served as a manifest, and names icons that exist', { skip: !built }, async () => {
  const res = await app.client()('GET', '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/manifest\+json/);
  const manifest = JSON.parse(res.text) as { name: string; start_url: string; display: string; theme_color: string; icons: { src: string; sizes: string; purpose?: string }[] };
  assert.equal(manifest.name, 'PhotoScout');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0e1014');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const img = await app.client()('GET', icon.src);
    assert.equal(img.status, 200, icon.src);
    assert.equal(img.headers.get('content-type'), 'image/png', icon.src);
  }
});

test('the service worker is served as JavaScript and is re-checked on every launch', { skip: !built }, async () => {
  const res = await app.client()('GET', '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.match(res.headers.get('cache-control') ?? '', /no-cache/);
});

test('the service worker never touches /api', { skip: !built }, async () => {
  const src = (await app.client()('GET', '/sw.js')).text;
  assert.match(src, /startsWith\('\/api\/'\)\) return;/);
  assert.doesNotMatch(src, /cache\.put\([^)]*api/);
});
