import path from 'node:path';
import { db, dataDir } from '../db.js';
import { listEvents } from '../events/local.js';
import { ingestPluginEvents } from '../events/refresh.js';
import { tasks } from '../tasks/tasks.js';
import { bundledDirs, installBundled } from './bundled.js';
import { createPluginRuntime } from './runtime.js';

/** The app's one plugin runtime, over the main database and the task registry. Nothing starts until loadAll() is called. */
export const pluginRuntime = createPluginRuntime({
  db,
  root: path.join(dataDir, 'plugins'),
  taskRegistry: tasks,
  ingestEvents: ingestPluginEvents,
  listEvents,
});

/**
 * Install (or upgrade) the plugins that ship with the app. Call before loadAll():
 * it only writes to the store, and loadAll() then starts whatever is enabled.
 * Never throws: a bad bundled zip is logged and the rest carry on.
 */
export function installBundledPlugins(): void {
  for (const dir of bundledDirs()) {
    const report = installBundled(dir, pluginRuntime.store);
    for (const id of report.installed) console.log(`[plugins] installed bundled plugin ${id}`);
    for (const id of report.upgraded) console.log(`[plugins] upgraded bundled plugin ${id}`);
    for (const item of report.kept) console.log(`[plugins] kept ${item.file}: ${item.reason}`);
    for (const item of report.failed) console.error(`[plugins] bundled ${item.file} not installed: ${item.reason}`);
  }
}
