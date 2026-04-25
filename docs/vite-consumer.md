# Using from a Vite consumer (source alias)

When you alias `@laboverwire/stitch` to the source (e.g. from a monorepo sibling or a vendored checkout) **and** the `mqdb-wasm` / `mqtt5-wasm` `node_modules` folder lives above your Vite project root, add that folder to `server.fs.allow`:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@laboverwire/stitch': resolve(here, '../path/to/stitch/src/index.ts'),
    },
  },
  server: {
    fs: { allow: [resolve(here, '../path/to/stitch')] },
  },
  optimizeDeps: {
    exclude: ['mqdb-wasm', 'mqtt5-wasm'],
  },
});
```

Without `fs.allow`, Vite serves WASM binaries with HTTP 403 and `WebAssembly.instantiateStreaming` fails. If you install `@laboverwire/stitch` as a normal npm dependency instead, neither the alias nor the `fs.allow` entry is needed.
