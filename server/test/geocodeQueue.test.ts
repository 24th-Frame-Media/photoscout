import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { geocode, geocodeLimits, GeocoderBusyError } from '../src/geocode.js';

test('geocode: lookups beyond the queue cap are refused at once, and the queued ones still run', async () => {
  const db = createDb(':memory:');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify([{ display_name: 'Somewhere', lat: '1', lon: '2', class: 'place', type: 'town' }]), { status: 200 });
  }) as typeof fetch;
  const saved = { ...geocodeLimits };
  geocodeLimits.gapMs = 5;
  try {
    const runs = Array.from({ length: geocodeLimits.maxQueued + 3 }, (_, i) =>
      geocode(db, `queue test ${i}`).then(() => 'ok', (err) => (err instanceof GeocoderBusyError ? 'busy' : 'error')));
    const outcomes = await Promise.all(runs);
    assert.equal(outcomes.filter((o) => o === 'busy').length, 3);
    assert.equal(outcomes.filter((o) => o === 'ok').length, geocodeLimits.maxQueued);
    assert.equal(calls, geocodeLimits.maxQueued);
    // Once the queue drains, a new lookup is taken again.
    assert.equal((await geocode(db, 'after the rush')).length, 1);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(geocodeLimits, saved);
  }
});
