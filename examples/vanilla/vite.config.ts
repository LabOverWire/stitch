import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
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
});
