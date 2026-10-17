import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, pluginApp, listen, pluginPackage, type Harness, type Listening } from './helpers.js';
import {
  getPluginEventSource,
  listPluginEventSources,
  tryPluginEventImporters,
} from '../../src/events/pluginSources.js';
import { DEFAULT_SETTINGS, MissingConfigError } from '../../src/events/sources/types.js';
import { cullReason } from '../../src/events/cull.js';

const harnesses: Harness[] = [];
const servers: Listening[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of harnesses.splice(0)) await h.close();
});

function harness(opts: Parameters<typeof makeRuntime>[0] = {}): Harness {
  const h = makeRuntime(opts);
  harnesses.push(h);
  return h;
}

async function serve(h: Harness): Promise<string> {
  const s = await listen(pluginApp(h.runtime));
  servers.push(s);
  return s.base;
}

const ID = 'media.test.events';

test('ctx.events.registerSource registers an event provider with topics/terms and unregisters on stop', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      name: 'Humanitix Scraper',
      photoscout: '^1.3',
      permissions: [{ kind: 'events', detail: 'Humanitix local events' }],
      server: [
        'export default { activate(ctx) {',
        '  ctx.events.registerSource({',
        "    id: 'humanitix',",
        "    label: 'Humanitix',",
        "    description: 'Community events from Humanitix',",
        '    unofficial: true,',
        '    areaScoped: true,',
        '    async fetch(area) {',
        '      if (ctx.settings.get().missing) return { missingConfig: "Set API token in plugin settings" };',
        '      return [{',
        '        sourceId: `hx-${area.city}`,',
        '        title: `Market in ${area.city}`,',
        "        startTime: '2026-11-01T10:00:00Z',",
        '        description: `Topics: ${area.topics.join(",")} | Terms: ${area.terms.slice(0, 2).join(",")}`,',
        '        venueName: area.city,',
        '        lat: area.lat,',
        '        lng: area.lng,',
        '      }];',
        '    }',
        '  });',
        '} };',
      ].join('\n'),
      settings: [{ key: 'missing', type: 'boolean', label: 'Simulate missing config', default: false }],
    }),
    { source: 'upload' },
  );

  const status = await h.runtime.activate(ID);
  assert.equal(status.status, 'active');

  const sourceName = `plugin:${ID}:humanitix`;
  const adapter = getPluginEventSource(sourceName);
  assert.ok(adapter, 'source is registered in pluginSources');
  assert.equal(adapter.label, 'Humanitix');
  assert.equal(adapter.unofficial, true);
  assert.equal(adapter.areaScoped, true);
  assert.equal(adapter.pluginId, ID);
  assert.equal(adapter.pluginName, 'Humanitix Scraper');
  assert.equal(adapter.description, 'Community events from Humanitix');

  // Area-scoped plugin source should not be culled when unplaced
  assert.equal(
    cullReason(
      {
        lat: null,
        lng: null,
        locality: '',
        area: '',
        category: 'Markets',
        starred: false,
        unknownLocation: true,
        sources: [{ source: sourceName, url: 'https://events.humanitix.com/x' }],
        edited: [],
      },
      [{ name: 'Bathurst', lat: -33.42, lng: 149.58, radiusKm: 50 }],
      { cullOutsideAreas: true },
    ),
    null,
  );

  const settings = {
    ...DEFAULT_SETTINGS,
    eventTopics: ['markets'],
    webSearchTerms: ['sunset shoot'],
  };
  const events = await adapter.fetchEvents(
    { city: 'Bathurst', lat: -33.4193, lng: 149.5775, radiusKm: 50 },
    settings,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceId, 'hx-Bathurst');
  assert.equal(events[0].title, 'Market in Bathurst');
  assert.match(events[0].description ?? '', /Topics: markets/);
  assert.ok(events.some((e) => (e.description ?? '').includes('sunset shoot') || (e.description ?? '').includes('markets')));

  // Returning { missingConfig } translates to MissingConfigError for refreshAll()
  h.runtime.updateSettings(ID, { missing: true });
  await assert.rejects(
    () => adapter.fetchEvents({ city: 'Bathurst', lat: -33.4193, lng: 149.5775, radiusKm: 50 }, settings),
    (err: unknown) => err instanceof MissingConfigError && /Set API token/.test(err.message),
  );

  // Deactivating the plugin removes the event source
  await h.runtime.deactivate(ID);
  assert.equal(getPluginEventSource(sourceName), undefined);
  assert.equal(listPluginEventSources().some((s) => s.name === sourceName), false);
});

test('ctx.events.registerImporter hooks into link importing and unregisters on stop', async () => {
  const h = harness();
  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      photoscout: '^1.3',
      server: [
        'export default { activate(ctx) {',
        '  ctx.events.registerImporter({',
        "    id: 'custom-site',",
        "    label: 'Custom Tickets',",
        "    match: (url) => url.startsWith('https://tickets.example.org/'),",
        '    read: async (url) => [{',
        '      sourceId: url,',
        "      title: 'Scraped Concert',",
        "      startTime: '2026-12-05T19:30:00Z',",
        "      venueName: 'Civic Hall',",
        '      url,',
        '    }],',
        '  });',
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );

  assert.equal((await h.runtime.activate(ID)).status, 'active');

  const hit = await tryPluginEventImporters('https://tickets.example.org/gig-42');
  assert.ok(hit);
  assert.equal(hit.label, 'Custom Tickets');
  assert.equal(hit.events.length, 1);
  assert.equal(hit.events[0].title, 'Scraped Concert');

  const miss = await tryPluginEventImporters('https://other.example.org/gig-42');
  assert.equal(miss, null);

  await h.runtime.deactivate(ID);
  assert.equal(await tryPluginEventImporters('https://tickets.example.org/gig-42'), null);
});

test('ctx.events.ingest, extractFromHtml and list work from plugin routes', async () => {
  const ingestedCalls: { sourceName: string; count: number }[] = [];
  const h = harness({
    ingestEvents: async (sourceName, items) => {
      ingestedCalls.push({ sourceName, count: items.length });
      return { kept: items.length, rejected: 0, outsideArea: 0 };
    },
    listEvents: (query) => [
      {
        group: 'g1',
        title: `Event in ${String(query?.place ?? 'Anywhere')}`,
        description: '',
        startTime: '2026-11-10T09:00:00Z',
        endTime: null,
        dateOnly: false,
        venueName: 'Showground',
        address: 'Bathurst NSW',
        locality: 'Bathurst',
        place: String(query?.place ?? 'Bathurst'),
        area: 'Bathurst',
        lat: -33.42,
        lng: 149.58,
        imageUrl: '',
        category: 'Festival',
        priceText: 'Free',
        isOnline: false,
        photoScore: 8,
        sources: [{ source: `plugin:${ID}:push`, url: 'https://example.com/e1' }],
      },
    ],
  });

  h.runtime.store.installFromZip(
    pluginPackage({
      id: ID,
      photoscout: '^1.3',
      server: [
        'export default { activate(ctx) {',
        "  ctx.events.registerSource({ id: 'push', label: 'Webhook Feed', fetch: async () => [] });",
        "  ctx.router.post('/webhook', async (req, res) => {",
        '    const html = req.body.html;',
        "    const extracted = ctx.events.extractFromHtml(html, 'https://club.example.com/calendar');",
        "    const stats = await ctx.events.ingest('push', extracted);",
        '    res.json({ extracted: extracted.length, stats });',
        '  });',
        "  ctx.router.get('/upcoming', (req, res) => {",
        "    res.json(ctx.events.list({ place: String(req.query.place || 'Bathurst'), limit: 10 }));",
        '  });',
        '} };',
      ].join('\n'),
    }),
    { source: 'upload' },
  );

  assert.equal((await h.runtime.activate(ID)).status, 'active');
  const base = await serve(h);

  const sampleHtml = `
    <html><head>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Event",
          "name": "Spring Hill Climb",
          "startDate": "2026-11-15T08:00:00+11:00",
          "location": { "@type": "Place", "name": "Mount Panorama", "address": "Bathurst NSW" }
        }
      </script>
    </head><body></body></html>
  `;

  const pushRes = await fetch(`${base}/api/plugins/${ID}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: sampleHtml }),
  });
  assert.equal(pushRes.status, 200);
  const pushBody = (await pushRes.json()) as { extracted: number; stats: { kept: number } };
  assert.equal(pushBody.extracted, 1);
  assert.equal(pushBody.stats.kept, 1);
  assert.deepEqual(ingestedCalls, [{ sourceName: `plugin:${ID}:push`, count: 1 }]);

  const listRes = await fetch(`${base}/api/plugins/${ID}/upcoming?place=Orange`);
  assert.equal(listRes.status, 200);
  const items = (await listRes.json()) as { title: string; place: string }[];
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Event in Orange');
});
