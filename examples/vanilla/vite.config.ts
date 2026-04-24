import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@laboverwire/stitch': resolve(here, '../../src/index.ts'),
    },
  },
  server: {
    port: 5176,
    fs: {
      allow: [resolve(here, '../..')],
    },
  },
  optimizeDeps: {
    exclude: ['mqdb-wasm', 'mqtt5-wasm'],
  },
});
