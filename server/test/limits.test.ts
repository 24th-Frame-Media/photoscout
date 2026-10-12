import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './httpHarness.js';
import { guardedFetch } from '../src/ssrf.js';

// Every other HTTP test switches the limits off; this one is what they are for.
const app = await startApp({ RATE_LIMITS: '' });
after(() => app.close());

test('sign-in round trips are limited by address', async () => {
  const c = app.client();
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await c('GET', '/api/auth/google/start')).status;
  assert.equal(last, 302, 'the fortieth still goes through');
  const over = await c('GET', '/api/auth/google/start');
  assert.equal(over.status, 429);
  assert.match(over.json.error, /Too many sign-in attempts/);
  assert.ok(over.headers.get('retry-after'), 'and says when to come back');
  assert.equal((await c('GET', '/api/version')).status, 200, 'the rest of the site is not locked with it');
});

test('guardedFetch: a redirect to a private address is checked like the first hop', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.startsWith('https://93.184.216.34/')) {
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return real(input, init);
  };
  try {
    await assert.rejects(guardedFetch('https://93.184.216.34/share'), /private|not allowed|blocked/i);
    assert.deepEqual(seen, ['https://93.184.216.34/share'], 'the private address was never asked');
  } finally {
    globalThis.fetch = real;
  }
});
