import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  crawlerConfigFrom, FLYER_BONUS, GOOD_WEIGHT, outcomeOfEvent, tallyVerdicts, UNPLACED_FACTOR,
} from '../../src/events/sources/crawler.js';
import { DEFAULT_SETTINGS } from '../../src/events/sources/types.js';

/**
 * The gap this closes: only the extra search terms used to be passed, and
 * with those empty — the usual case — the crawler fell back on a generic list
 * of its own and ignored every topic that had been chosen.
 */
test('the crawler searches for the topics chosen in Settings, in every area', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    eventAreas: [{ name: 'Orange NSW' }, { name: 'bathurst' }],
    eventTopics: ['motorsport'],
    webSearchTerms: ['Bathurst 1000'],
  });
  assert.deepEqual(config.interests.map((i) => i.city), ['Bathurst', 'Orange NSW'], 'each area once');
  const terms = config.interests[0].terms;
  assert.ok(terms.length > 1, 'the topic expanded into its terms');
  assert.ok(terms.includes('Bathurst 1000'), 'extra terms ride along');
  assert.ok(terms.every((t) => !t.includes('Orange')), 'terms go over bare; the crawler adds the place');
  assert.deepEqual(config.interests[1].terms, terms, 'every area gets the same list');
});

test('only real web addresses are pinned, and each once', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    crawlerUrls: ['https://a.com/whats-on', '  https://a.com/whats-on  ', 'ftp://b.com', 'not a url', ''],
  });
  assert.deepEqual(config.seeds, ['https://a.com/whats-on']);
});

test('no location means nowhere to search', () => {
  assert.deepEqual(crawlerConfigFrom({ ...DEFAULT_SETTINGS, city: '' }).interests, []);
});

test('crawler config includes ollamaUrl and llmModel when llm is enabled', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    llmEnabled: true,
    llmUrl: 'http://ollama.local:11434',
    llmModel: 'llama3:8b',
  });
  assert.equal(config.ollamaUrl, 'http://ollama.local:11434');
  assert.equal(config.llmModel, 'llama3:8b');
});

test('crawler config omits ollamaUrl when llm is disabled', () => {
  const config = crawlerConfigFrom({
    ...DEFAULT_SETTINGS,
    city: 'Bathurst',
    llmEnabled: false,
    llmUrl: 'http://ollama.local:11434',
    llmModel: 'llama3:8b',
  });
  assert.equal(config.ollamaUrl, undefined);
  assert.equal(config.llmModel, 'llama3:8b');
});

test('syncCrawler sends ollamaUrl and llmModel to the crawler endpoint', async () => {
  const { syncCrawler } = await import('../../src/events/sources/crawler.js');
  let sentBody: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await syncCrawler({
      ...DEFAULT_SETTINGS,
      crawlerUrl: 'http://crawler.local:3002',
      city: 'Bathurst',
      llmEnabled: true,
      llmUrl: 'http://ollama.local:11434',
      llmModel: 'llama3:8b',
    });
    assert.equal(res.ok, true);
    assert.equal((sentBody as { ollamaUrl?: string })?.ollamaUrl, 'http://ollama.local:11434');
    assert.equal((sentBody as { llmModel?: string })?.llmModel, 'llama3:8b');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('a find is good when it is shown, worth more with a flyer, and bad when culled, hidden or never stored', () => {
  const shown = { culled: null, hidden: false, area: 'Bathurst', images: ['a.jpg'] };
  assert.deepEqual(outcomeOfEvent(shown), { state: 'shown', inArea: true, hasImage: true });
  assert.equal(outcomeOfEvent({ ...shown, culled: '300 km from Bathurst, the nearest area' }).state, 'bad');
  assert.equal(outcomeOfEvent({ ...shown, hidden: true }).state, 'bad');
  assert.equal(outcomeOfEvent({ ...shown, culled: 'Waiting to be checked' }).state, 'undecided', 'the model has not read it yet');

  const verdicts = tallyVerdicts([
    { foundOn: 'https://a.example/whats-on', outcome: outcomeOfEvent(shown) },
    { foundOn: 'https://a.example/whats-on', outcome: outcomeOfEvent({ ...shown, images: [] }) },
    { foundOn: 'https://a.example/whats-on', outcome: outcomeOfEvent({ ...shown, area: '', images: [] }) },
    { foundOn: 'https://a.example/whats-on', outcome: outcomeOfEvent({ ...shown, hidden: true }) },
    { foundOn: 'https://a.example/whats-on', outcome: null },
    { foundOn: 'https://a.example/whats-on', outcome: outcomeOfEvent({ ...shown, culled: 'Waiting to be checked' }) },
    { foundOn: 'https://b.example/', outcome: null },
  ]);
  assert.deepEqual(verdicts, [
    // 1.5 with a flyer, 1 without, 0.5 for one filed under no area
    { foundOn: 'https://a.example/whats-on', good: GOOD_WEIGHT + FLYER_BONUS + GOOD_WEIGHT + GOOD_WEIGHT * UNPLACED_FACTOR, bad: 2 },
    { foundOn: 'https://b.example/', good: 0, bad: 1 },
  ]);
});
