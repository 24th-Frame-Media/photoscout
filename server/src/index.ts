import { app } from './app.js';
import { runDueTasksOnStartup, startScheduler } from './tasks/scheduler.js';
import { startEvents } from './events/index.js';

const PORT = Number(process.env.API_PORT ?? 3003);
app.listen(PORT, () => {
  console.log(`photoscout server listening on http://localhost:${PORT}`);
});

startScheduler();
startEvents();
runDueTasksOnStartup();
