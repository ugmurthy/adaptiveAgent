import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  // Mermaid lazily loads some uncommon diagram renderers as standalone chunks. The
  // largest is below 700 kB and is not part of the initial renderer payload.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
