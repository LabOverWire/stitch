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
| `vanilla` | ~170 lines of TS + one HTML file. Smallest useful demo; exercises `createStore`, `initialize`, `listRootEntities`, `replaceScope`, `getSnapshot`, `subscribeToScope`, `subscribeToEntity`, `subscribeToConnectionStatus`, CRUD. Good reference + smoke test. |
| `react`   | `<StoreProvider>` + `<AuthProvider>`, `useStore`, `useEntitySnapshot`, `useSyncScope`, `useConnectionStatus`, `useRootEntityList`. Runs under `<StrictMode>`. |
| `vue`     | `<StoreRoot>` + `<StitchAuth>`, `useStore`, `useEntitySnapshot`, `useSyncScope`, `useConnectionStatus`, `useRootEntityList`. |

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

Each example's entry point (`stitch.ts` for React/Vue, `main.ts` for vanilla) checks `import.meta.env.VITE_STITCH_SERVER_URL`. Set it to opt into remote sync — without it, the store runs memory + IndexedDB only and no broker is needed.

```bash
VITE_STITCH_SERVER_URL=ws://localhost:8080/mqtt npm run dev
```

Anonymous broker (no auth): start the broker with `--anonymous` and leave `VITE_STITCH_AUTH_TICKET` unset. The examples omit `remote.ticket` when none is configured, so the MQTT5 `authenticationMethod` / `authenticationData` headers aren't sent and the anonymous broker accepts the CONNECT.

```bash
mqdb agent start --db /tmp/stitch-mqdb-data --bind 127.0.0.1:11883 --ws-bind 127.0.0.1:18080 --anonymous
VITE_STITCH_SERVER_URL=ws://127.0.0.1:18080/mqtt npm run dev
```

Authenticated broker: set `VITE_STITCH_AUTH_TICKET` to a JWT; the examples forward it as `remote.ticket` for MQTT v5 enhanced auth.

## WASM plugins and `server.fs.allow`

`@laboverwire/stitch` is a thin layer over `@laboverwire/stitch-wasm`, which ships as a `wasm-bindgen` bundler-target ESM module. Each `vite.config.ts` therefore enables `vite-plugin-wasm` and `vite-plugin-top-level-await`; without them the WASM module fails to instantiate. This mirrors the guidance in [`docs/vite-consumer.md`](../docs/vite-consumer.md).

Each config also sets `server.fs.allow` to the repo root: the examples alias `@laboverwire/stitch` to `../../src/index.ts`, and stitch imports `@laboverwire/stitch-wasm` — whose `*_bg.wasm` binary lives in the repo-root `node_modules/`, above each example's Vite root. Without `fs.allow`, Vite serves that path as HTTP 403 and instantiation fails. If you copy one of these examples into a standalone repo that installs `@laboverwire/stitch` normally, both the alias and the `fs.allow` entry can be removed — but the two plugins are still required.
