import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.SERVICE_API_URL || 'http://127.0.0.1:3000';
  return {
    plugins: [svelte()],
    build: { outDir: 'dist/client', emptyOutDir: true },
    server: {
      port: 5175,
      proxy: {
        '/v1/ws': { target, ws: true },
        '/v1': { target },
        '/health': { target },
      },
    },
  };
});
