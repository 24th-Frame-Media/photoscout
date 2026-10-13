import { app } from './app.js';
import { attachRealtime } from './realtime.js';
import { startEvents } from './events/index.js';

const PORT = Number(process.env.API_PORT ?? 3003);
const server = app.listen(PORT, () => {
  console.log(`photoscout server listening on http://localhost:${PORT}`);
});
attachRealtime(server);

void startEvents();
