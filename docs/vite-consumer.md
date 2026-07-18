# Using from a Vite consumer

`@laboverwire/stitch` is a thin binding layer over `@laboverwire/stitch-wasm`, which ships as a `wasm-bindgen` bundler-target ESM module (it uses the ESM wasm import proposal). To load it, a consuming Vite app **must** add `vite-plugin-wasm` and `vite-plugin-top-level-await`:

```bash
npm install -D vite-plugin-wasm vite-plugin-top-level-await
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
});
```

This mirrors what this repo's own `vitest.config.ts` does — the browser test suite loads the real wasm through the same two plugins. Without them the wasm module fails to instantiate. `build.target: 'esnext'` is required for production builds: the wasm-bindgen module and `vite-plugin-top-level-await` emit top-level `await`, which older build targets can't down-level.

## Source alias (monorepo sibling or vendored checkout)

When you alias `@laboverwire/stitch` to the source (e.g. from a monorepo sibling or a vendored checkout) **and** the `@laboverwire/stitch-wasm` `node_modules` folder lives above your Vite project root, also add that folder to `server.fs.allow` so the `.wasm` binary resolves:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  resolve: {
    alias: {
      '@laboverwire/stitch': resolve(here, '../path/to/stitch/src/index.ts'),
    },
  },
  server: {
    fs: { allow: [resolve(here, '../path/to/stitch')] },
  },
});
```

If you install `@laboverwire/stitch` as a normal npm dependency instead, the alias and the `fs.allow` entry are not needed — but the `vite-plugin-wasm` / `vite-plugin-top-level-await` plugins are required either way.
