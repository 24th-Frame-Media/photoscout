import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' }, // MapLibre's worker is an ES module
  server: {
    port: 5174,
    // Saves are only accepted from PUBLIC_URL, so moving to another port when this one is taken would break them.
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3003',
      // Plugin web bundles are served by the backend at /plugins/<id>/<version>/web.js;
      // without this the SPA (on 5174) can't load them in dev and every web plugin fails.
      '/plugins': 'http://localhost:3003',
      // The convoy and chat socket.
      '/ws': { target: 'http://localhost:3003', ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
