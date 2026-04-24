# Stitch examples

Three standalone apps that consume `@laboverwire/stitch` via Vite path aliases pointing at the repo source. No publish required.

All three implement the same domain (`project` with `task` children) to make binding parity directly comparable.

## Run them

```bash
cd examples/vanilla && npm install && npm run dev   # http://localhost:5176
cd examples/react   && npm install && npm run dev   # http://localhost:5173
cd examples/vue     && npm install && npm run dev   # http://localhost:5175
```

## What each one shows

| Example   | What it is                                                  |
|-----------|-------------------------------------------------------------|
| `vanilla` | ~100 lines of TS + one HTML file. Smallest useful demo; exercises `createStore`, `initialize`, `listRootEntities`, `openScope`, `getSnapshot`, `subscribeToScope`, `subscribeToEntity`, CRUD. Good reference + smoke test. |
| `react`   | `<StoreProvider>`, `useStore`, `useEntitySnapshot`, `useSyncScope`, `useConnectionStatus`, `useRootEntityList`. Runs under `<StrictMode>`. |
| `vue`     | `<StitchRoot>`, `useStore`, `useEntitySnapshot`, `useEntitySnapshotAsMap`, `useSyncScope`, `useConnectionStatus`. |

## Verify end-to-end

1. Page loads, store shows as ready (offline remote — see below).
2. Create a project → it appears in the list.
3. Select it, create a task → it appears immediately.
4. Toggle the checkbox, delete a task, they persist.
5. Hard-refresh → project and tasks reload from IndexedDB.
6. DevTools → Application → IndexedDB → inspect the `project`, `task`, and `pending_sync` tables.

## Type-check

```bash
cd examples/vanilla && npm run type-check
cd examples/react   && npx tsc --noEmit
cd examples/vue     && npm run type-check
```

The root `npm test` runs the Vitest suite in real Chromium via Playwright.

## Optional MQTT sync

Each example's `stitch.ts` checks `import.meta.env.VITE_STITCH_SERVER_URL`. Set it to opt into remote sync — without it, the store runs memory + IndexedDB only and no broker is needed.

```bash
VITE_STITCH_SERVER_URL=ws://localhost:8080/mqtt npm run dev
```

## Vite `server.fs.allow` note

Each `vite.config.ts` sets `server.fs.allow` to the repo root. The examples alias `@laboverwire/stitch` to `../../src/index.ts` and stitch imports `mqdb-wasm` / `mqtt5-wasm` — whose `*_bg.wasm` binaries live in the repo-root `node_modules/`, which is above each example's Vite root. Without `fs.allow`, Vite serves those paths as HTTP 403 and WASM instantiation fails. If you copy one of these examples into a standalone repo that installs `@laboverwire/stitch` normally, both the alias and the `fs.allow` entry can be removed.
