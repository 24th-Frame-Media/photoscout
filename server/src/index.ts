import { app } from './app.js';
import { attachRealtime } from './realtime.js';
import { runDueTasksOnStartup, startScheduler } from './tasks/scheduler.js';
import { startEvents } from './events/index.js';
import { installBundledPlugins, pluginRuntime } from './plugins/host.js';

const PORT = Number(process.env.API_PORT ?? 3003);
const server = app.listen(PORT, () => {
  console.log(`photoscout server listening on http://localhost:${PORT}`);
});
attachRealtime(server);

startScheduler();
void startEvents();
runDueTasksOnStartup();
// Bundled plugins are installed first, so loadAll() starts them with the rest.
// A plugin that fails to start is logged and marked in the admin page; it never stops the server.
installBundledPlugins();
pluginRuntime.loadAll().catch((err: unknown) => console.error(`[plugins] startup failed: ${(err as Error).message}`));
