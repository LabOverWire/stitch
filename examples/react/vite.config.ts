import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  resolve: {
    alias: {
      '@laboverwire/stitch/react': resolve(here, '../../src/react/index.ts'),
      '@laboverwire/stitch': resolve(here, '../../src/index.ts'),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [resolve(here, '../..')],
    },
  },
});
