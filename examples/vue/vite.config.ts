import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue(), wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  resolve: {
    alias: {
      '@laboverwire/stitch/vue': resolve(here, '../../src/vue/index.ts'),
      '@laboverwire/stitch': resolve(here, '../../src/index.ts'),
    },
  },
  server: {
    port: 5175,
    fs: {
      allow: [resolve(here, '../..')],
    },
  },
});
