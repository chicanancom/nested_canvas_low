import { defineConfig } from 'vite';
import { startSyncServer } from './server/sync_server.js';

let syncInstance = globalThis.__nestedcanvas_sync_instance || null;

export default defineConfig({
  plugins: [
    {
      name: 'nestedcanvas-sync-server-launcher',
      configureServer(server) {
        if (syncInstance) {
          try {
            syncInstance.wss?.close();
            syncInstance.server?.close();
          } catch (e) {}
          syncInstance = null;
          globalThis.__nestedcanvas_sync_instance = null;
        }

        try {
          syncInstance = startSyncServer(8765);
          globalThis.__nestedcanvas_sync_instance = syncInstance;
        } catch (e) {
          console.warn('[Vite Sync Server Launcher] Could not start sync server:', e.message);
        }

        server.httpServer?.on('close', () => {
          if (syncInstance) {
            try {
              syncInstance.wss?.close();
              syncInstance.server?.close();
            } catch (e) {}
            syncInstance = null;
            globalThis.__nestedcanvas_sync_instance = null;
          }
        });
      },
    },
  ],
  server: {
    port: 3000,
    host: true,
  },
});
