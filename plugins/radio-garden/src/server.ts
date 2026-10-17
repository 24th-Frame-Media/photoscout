import type { PluginContext, ServerPlugin } from '@photoscout/plugin-sdk/server';
import {
  fetchRadioPlaces,
  fetchRadioStations,
  getProviderListenUrl,
  isValidRadioId,
  RadioProviderError,
  type RadioFetch,
  type RadioKv,
} from './radio.js';

/**
 * Radio Garden's server side, as a plugin. Routes are relative to
 * /api/plugins/media.24thframe.radio-garden/; plugin.json declares the three
 * GET routes public, so a visitor can use them without signing in.
 *
 * This file is bundled into one self-contained server.js (see build.mjs), so it
 * imports nothing relative at runtime. The type import above is erased.
 */

/**
 * An error as the client sees it. A provider error carries a message written for
 * the client; anything else is logged by the host and answered with a fixed line.
 */
function answerError(res: { status(code: number): { json(body: unknown): void } }, err: unknown): void {
  if (err instanceof RadioProviderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(502).json({ error: 'Radio Garden is unavailable' });
}

/** The plugin's own key-value cache, in its own SQLite file. */
function kvOver(ctx: PluginContext): RadioKv {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = ctx.db.prepare('SELECT value FROM kv WHERE key = ?');
  const write = ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    get: (key) => (read.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => {
      write.run(key, value);
    },
  };
}

const plugin: ServerPlugin = {
  activate(ctx) {
    const kv = kvOver(ctx);
    // Only public internet addresses; the host's guarded fetch refuses the rest.
    const fetchFn: RadioFetch = (url, init) => ctx.fetch(url, init);

    ctx.router.get('/places', async (_req, res) => {
      try {
        const places = await fetchRadioPlaces(kv, { fetchFn });
        res.json({ places });
      } catch (err) {
        answerError(res, err);
      }
    });

    ctx.router.get('/places/:id/stations', async (req, res) => {
      try {
        const { id } = req.params;
        if (!isValidRadioId(id)) {
          res.status(400).json({ error: 'Invalid place ID' });
          return;
        }
        const details = await fetchRadioStations(kv, id, { fetchFn });
        res.json(details);
      } catch (err) {
        answerError(res, err);
      }
    });

    ctx.router.get('/stations/:id/listen', (req, res) => {
      const { id } = req.params;
      if (!isValidRadioId(id)) {
        res.status(400).json({ error: 'Invalid station channel ID' });
        return;
      }
      res.redirect(307, getProviderListenUrl(id));
    });
  },
};

export default plugin;
