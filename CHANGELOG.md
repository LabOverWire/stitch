# Changelog

## Unreleased

### Added

- _Nothing yet._

## 0.5.0

### Changed (breaking)

- **Store backend replaced by `@laboverwire/stitch-wasm`.** The entire TypeScript store — memory cache, IndexedDB persistence, MQTT sync, offline queue — has been removed. `@laboverwire/stitch` is now a thin, framework-agnostic binding layer: `src/store.ts` is a small adapter that wraps the Rust/WASM `Store` from `@laboverwire/stitch-wasm` (`^0.2.1`), and the package ships the same React and Vue bindings. All store/sync/persistence/offline-queue/MQTT logic now lives inside the wasm (compiled from the sibling `stitch-rs` repo).
- **`StoreOptions.remote` shape changed.** `remote` is now `{ url, clientId?, ticket?, username?, password? }` instead of `{ serverUrl, getTicket }`. `url` is a `ws://`|`wss://` MQTT endpoint; `ticket` is a JWT for MQTT v5 enhanced auth; `username`/`password` drive classic MQTT password auth. `persistence` is `{ dbName, passphrase? }` — supplying `passphrase` enables AES-GCM encryption.
- **`responseTopicPrefix` default moved off `$SYS`.** Default changed from `$SYS/responses` to `$DB/clients`. The previous default published responses under `$SYS`, which the MQTT 5 spec reserves for broker-internal use (§4.7.2) — production brokers (EMQX, HiveMQ, AWS IoT Core) reject client publishes under `$SYS` by default ACL, so the old default only worked against permissive or custom-configured brokers. Per-request response topic shape is unchanged: `{prefix}/{clientId}/{requestId}`. The `responseTopicPrefix` config field still exists on `StoreConfig` and is forwarded to the wasm; only the implementation moved. Deployments overriding `responseTopicPrefix` explicitly are unaffected. Deployments relying on the old default must either set `responseTopicPrefix: '$SYS/responses'` to preserve current behavior or update broker ACLs to accept the new `$DB/clients/...` topic.
- **Subscription callbacks are now asynchronous.** `subscribeToEntity` and `subscribeToScope` callbacks fire one tick after the mutating call resolves, not synchronously within it. Callers that relied on synchronous delivery must not assume the callback has run by the time `create`/`update`/`delete` returns.
- **`connectionStatus` values are lowercase** — `'connected' | 'connecting' | 'disconnected' | 'error' | 'offline'`.

### Added

- **`@laboverwire/stitch-wasm` dependency** (`^0.2.1`) — the Rust/WASM store, MQTT client, and IndexedDB persistence, bundled as a single wasm-bindgen module.
- **Pre-initialize tolerance in the adapter.** The wasm store requires `initialize()` before use, but the TS adapter tolerates pre-init access: synchronous reads return empties (`[]` / `{}` / `null` / `0` / `'offline'`) before init, `subscribe*` defer wiring until `initialize()` resolves and then trigger a re-read, and async methods await init. React and Vue hooks are therefore safe to mount before the provider finishes initializing.
- **`Store.getVersion(scopeId, entity): number`** — reactivity token used by the memory snapshot cache.
- **`Store.pendingMutationCount(scopeId): Promise<number>`** — offline-queue depth for a scope.

### Removed

- **In-package store internals.** `src/memory-store.ts`, `src/persistence-layer.ts`, `src/remote-sync-layer.ts`, `src/sync-engine.ts`, `src/offline-queue.ts`, `src/internal-utils.ts`, and `src/internal-wasm-error.ts` deleted — their logic now lives in `@laboverwire/stitch-wasm`.
- **`mqdb-wasm` and `mqtt5-wasm` direct dependencies.** Both are now bundled inside `@laboverwire/stitch-wasm`.
- **Internal factory exports.** `createMemoryStore`, `createSyncEngine`, `createPersistenceLayer`, `createRemoteSyncLayer`, `createPersistentOfflineQueue`, `createInMemoryOfflineQueue` removed. The only value export is now `createStore`.
- **`OwnershipError` and `MqdbError` classes** removed — error handling for the wasm store no longer surfaces these TS types.
- **Session/auth-cache `Store` methods removed.** `getCachedUser`, `setCachedUser`, `clearCachedUser`, `hasPendingLogout`, `setPendingLogout`, and `flushPendingLogout` are no longer on `Store`. They were thin `sessionStorage` wrappers; apps that relied on them must reimplement the caching in application code.
- **Internal-layer interface types.** `SyncEngine`, `PersistenceLayer`, `RemoteSyncLayer`, `OfflineQueue`, `MutationSender`, `LocalAccessor`, `PendingMutation`, `ConsolidatedMutation`, `ScopeBundle`, `ScopeState`, `SyncMutation`, `MutationEvent` no longer exported. The public type surface is now `StoreConfig`, `EntityDefinition`, `SchemaField`, `ForeignKeyDefinition`, `ConnectionStatus`, `SortField`, `SortDirection`, `ListFilter`, `Store`, `StoreOptions`, `PersistenceConfig`, `RemoteConfig`, `MemoryStore`, `EntitySchema`, `DefaultSchema`, `EntityKey`, and `OriginTag`. The `MemoryStore` type still exists but is trimmed to `{ getSnapshot, getSnapshotAsMap, subscribeToScope }`.
- **Consumer Vite `server.fs.allow` / `optimizeDeps.exclude` guidance obsolete.** `stitch-wasm` ships a wasm-bindgen bundler-target ESM module (ESM wasm import proposal), so a consuming Vite app must instead add `vite-plugin-wasm` and `vite-plugin-top-level-await`, and set `build.target: 'esnext'` for production builds (the wasm module and the top-level-await plugin emit top-level `await`). The old `mqdb-wasm`/`mqtt5-wasm` filesystem-allow and dep-exclude instructions no longer apply and must be removed. This repo's `vitest.config.ts` now uses those two plugins and the browser test suite loads the real wasm.

### Fixed

- **React/Vue init-order safety.** Because the adapter tolerates pre-init access (see Added), hooks like `useEntitySnapshot`, `useScopedEntities`, and `useRootEntityList` no longer read stale or throwing state when a component mounts before the provider's `initialize()` resolves — `subscribe*` wires up and re-reads once init completes.
- **Brittle response-topic parsing** now lives in `@laboverwire/stitch-wasm`. The former `src/sync-engine.ts` regex that split `{prefix}/{clientId}/{requestId}` on a fixed segment count is gone along with the file; the wasm handles response-topic matching against the configured `responseTopicPrefix`.

### Unchanged

- **React bindings** — `StoreProvider`, `AuthProvider`, `useEntitySnapshot`, `useScopedEntities`, `useRootEntityList`, `useTopLevelEntities`, `useChildCounts`, `useConnectionStatus`, `useSyncScope`, `useStore` — and **Vue bindings** — `StoreRoot`, `StitchAuth`, matching composables, and `useStore` — keep the same API. `Store.reconnect(serverUrl, getTicket?)` also keeps its signature: the adapter resolves the ticket via `getTicket` and runs any reconnect validator.

## 0.4.3

### Added

- **Offline queue flush regression tests.** New `tests/unit/offline-queue-flush.test.ts` exercises `createInMemoryOfflineQueue.flushConsolidated` against the permanent/transient/conflict/ownership classifier paths added in 0.4.2, locking in the "drop after permanent or unknown error" terminal branch and the `OwnershipError` immediate re-throw.

### Changed

- **`typescript` bumped to `6.0.3`** (from `5.9.3`).
- **Dependabot grouped updates.** npm minor/patch and GitHub Actions groups updated to current versions.

## 0.4.2

### Fixed

- **Offline queue retry loop on permanent constraint errors.** `flushConsolidated` in `src/offline-queue.ts` did not match MQDB's actual error string `unique constraint violation: <entity>.<field>` in its conflict regex, and the terminal `else` branch logged the error without dequeuing — so any unclassified failure retried every flush cycle, indefinitely. Conflict regex extended; new `isPermanentMutationError` helper in `internal-utils.ts` covers the full MQDB constraint-failure set (`unique constraint violation`, `foreign key violation`, `not null violation`, `cascade blocked`, `referenced by other entities`) and dropping mutations after permanent or unknown errors is now the explicit terminal branch with a one-time log line.
- **`foreign key violation` mis-classified as transient.** `isTransientSyncError` previously matched `foreign key violation`, which is a permanent constraint failure and would never succeed on retry. Removed from the transient regex; covered by the new permanent classifier above.
- **Behavior change to call out:** previously, any error not classified as transient/conflict/not-found/ownership stayed in the offline queue and re-ran every flush cycle (visible only as repeated console errors). After this release, those entries are dropped after one attempt with a `Dropping mutation after permanent error:` or `Dropping mutation after unknown error:` log.
- **Vite sourcemap warnings.** `tsconfig.build.json` enabled `sourceMap: true` but not `inlineSources`, so the published `.map` files referenced `../src/*.ts` paths that are not in the npm tarball. Vite warned for every `dist/*.js` consumer-side. Added `inlineSources: true`; source content is now embedded in the maps.

## 0.4.1

### Fixed

- **Republish of `0.4.0`.** The `0.4.0` tag was pushed but the publish workflow failed before reaching the npm registry — `npm publish --provenance` requires `id-token: write` on the workflow's `permissions` block, which was missing. Fixed in the release workflow; `0.4.1` is the first version actually published to npm. No source changes from `0.4.0`.

## 0.4.0

### Changed (breaking)

- **Minimum supported Node bumped to `>=20`** (from `>=18`). Node 18 reached end-of-life and CI no longer exercises it. Consumers on Node 18 should upgrade to Node 20 LTS or 22.

### Changed

- **Open-source release.** Apache-2.0 license; `package.json` now carries `license`, `author`, `repository`, `bugs`, `homepage`, `keywords`, `engines`, `sideEffects`, and a `files` allowlist. `private: true` removed.
- **Build pipeline.** New `tsconfig.build.json` + `npm run build` emit ESM `dist/` via `tsc` with `rewriteRelativeImportExtensions` (rewrites `.ts` → `.js`). `exports` map points at `dist/index.js`, `dist/react/index.js`, `dist/vue/index.js` with matching `.d.ts` declarations. `prepublishOnly` runs `clean` + `check` + `build` so the npm tarball cannot ship without a green gate.
- **`mqdb-wasm` bumped to `0.3.2`** (from `0.3.1`).

### Fixed

- **Polynomial-time backtracking in WASM corruption detection.** `MemoryStore.isWasmCorrupted` and `PersistenceLayer.isDbCorrupted` previously matched error messages with a regex containing `transaction.*null`, which has polynomial complexity on inputs with many `transaction` prefixes (CodeQL `js/polynomial-redos`). Both helpers now delegate to a shared `isCorruptionError(err, extraPatterns)` exported from `internal-wasm-error.ts`, which uses substring `indexOf` checks — same semantics, linear time, and the corruption-pattern list lives in one place.

## 0.3.0

### Removed

- **Pre-0.2 monolithic store.** `PersistenceStore` interface, `createPersistenceStore` factory, and `PersistenceStoreImpl` (entire `src/persistence-store.ts` file) deleted. `createStore` + `Store` is the sole store surface.
- **React legacy bindings.** `StitchProvider`, `SyncStoreProvider` (alias), `StitchContext`, `StitchContextValue`, `SyncStoreContext`, `SyncStoreContextValue`, `useStitch`, `useSyncStore`, `usePersistenceToMemorySync` all removed. Use `<StoreProvider>` + `<AuthProvider>` with `useStore`.
- **Vue legacy root.** `StitchRoot` component removed. Use `<StoreRoot>` + `<StitchAuth>`.
- **Standalone persistence bridge.** `PersistenceBridge`, `PersistenceBridgeConfig`, and `createPersistenceBridge` removed — only meaningful with the removed `PersistenceStore` contract and had no internal consumer in 0.2. `StoreImpl` handles memory↔persistence relay internally.
- **`isStore()` helper** in `src/internal-utils.ts` removed — existed only to disambiguate the now-deleted `PersistenceStore | Store` union in the two `useConnectionStatus` entry points.

No migration shim. 0.2 consumers upgrading to 0.3 will see import errors at the removed names and must port to the unified API documented in `README.md`.

### Added

- **Anonymous broker support.** `SyncEngine.connect` / `.reconnect` now set `authenticationMethod = 'JWT'` only when `getTicket()` returns a non-empty string. Previously an empty ticket still produced a JWT auth attempt, which `mqdb --anonymous` rejects with `"Bad authentication method"`. A shared `applyTicketAuth(connectOpts, ticket)` helper replaces the duplicated inline block across both call sites.
- **Vanilla example remote wiring.** `examples/vanilla/src/main.ts` now reads `VITE_STITCH_SERVER_URL` (and optional `VITE_STITCH_AUTH_TICKET`), adds a `remote` block to `StoreOptions` when present, and renders the live connection status in the header. Parity with React/Vue examples.
- **`examples/**/.env.local`** is now gitignored alongside `node_modules` / `dist`.
- **Release tooling.** New `RELEASING.md` documents the cut-release recipe. `npm run release:check` runs `npm run check` plus a `scripts/verify-changelog.mjs` gate that fails when `## Unreleased` is empty. Package stays `private: true` — releases are git tags only.

### Fixed

- **Cross-tab hydration.** A second tab opened against a broker with pre-existing root entities would show an empty list until a page reload. `StoreImpl.onConnected` now calls `persistence.notifyAllEntitySubscribers()` after `syncRootEntityList` resolves, which triggers `useRootEntityList` / the vanilla example's `subscribeToEntity` callback to re-fetch once `initialSyncDone` is true. `onConnected` also catches and swallows sync errors so the notify runs on the success path only.
- **`subscribeToEntity` double-fire for persistence-backed stores.** The previous refactor wired both `memory.onMutation` and `persistence.subscribe` unconditionally, so every local create/update/delete notified consumers twice (React `useSyncExternalStore` re-rendered twice per mutation). `memory.onMutation` is now filtered to `'load'` and `'clear'` origin tags — the two tags that bypass the persistence path and therefore don't fire on the persistence side. Normal local mutations and remote mutations fire exactly once; `replaceScope` loads still reach subscribers.
- **Vue `OfflineQueuePanel` stuck on the "offline" hint.** The template read `ctx.store.hasRemote` (a class getter, not a reactive source), so Vue captured the pre-initialize `false` value and never re-rendered. Switched to the module-level `hasRemoteConfigured` exported from `stitch.ts` (what `ConnectionBanner` already uses).
- **`applyEvent` update no-op preserved.** Briefly changed to upsert while chasing the hydration bug; this resurrected deleted rows when a stale `update` arrived after a `delete`. Reverted with a regression test (`tests/unit/internal-list-apply.test.ts`).

## 0.2.0

### Added

- **Test harness.** Vitest 4 browser mode via Playwright/Chromium — real IndexedDB and WASM, no shims. 19 integration + unit specs. Run with `npm test`.
- **`MqdbError`.** Every call into `mqdb-wasm` that previously threw raw string or wasm-bindgen errors now throws a proper `Error` subclass with a method-qualified message (`mqdb.list:task: …`), the original exception on `.cause`, and a `.stack` frame. Exported from the public API.
- **Generic `Schema` type on `createStore`.** `createStore<{ project: Project; task: Task }>(…)` gives typed `read` / `getSnapshot` / `create` / `update` / `delete` / `list` / `subscribeToEntity` / `subscribeToScope`. Untyped callers keep `Record<string, unknown>`. New type exports: `EntitySchema`, `DefaultSchema`, `EntityKey`.
- **Split providers.**
  - React: `<StoreProvider>` (lifecycle) + `<AuthProvider>` (auth concerns).
  - Vue: `<StoreRoot>` (lifecycle) + `<StitchAuth>` (auth concerns).
- **Vue composables at hook parity.** `useRootEntityList`, `useScopedEntities`, `useChildCounts`, `useTopLevelEntities` — previously React-only.
- **`examples/vanilla/`.** Minimal TS + HTML reference (~100 lines) that exercises the core API without a framework.
- **Vite consumer docs.** Root README section on `server.fs.allow` for consumers aliasing from source.

### Changed (breaking)

- **`Store.openScope` → `Store.replaceScope`.** Same behavior, clearer name — the in-memory WASM DB is rebuilt on each call. The `useSyncScope` hook still exposes `openScope` as the function name (it now calls `store.replaceScope` internally). Rename direct call sites.
- **`StoreConfig.dbName` removed.** `options.persistence.dbName` is the sole source of truth. Memory-only stores don't need a name. Legacy `createPersistenceStore(config, dbName)` now takes `dbName` as a second argument.
- **Subscribe primitives consolidated.** `Store.subscribe` and `Store.onMutation` removed. `Store.subscribeToEntity(entity, (data, op) => …)` is now the only entity-level primitive and carries the full payload. `Store.subscribeToScope(scopeId, entity, () => void)` is unchanged. Migrate: `store.subscribe('x', cb)` → `store.subscribeToEntity('x', cb)`.
- **Provider split.** React: auth props (`userId`, `authenticated`, `onSessionInvalid`, `onReconnectValidate`) moved from `<StoreProvider>` to the new `<AuthProvider>`. Same split for Vue: move those props from `<StitchRoot>` to the new `<StitchAuth>`. Old components remain behind `@deprecated` until 0.3.

### Fixed

- **`addIndex` on persistent backend crash.** `persistence-layer.setupSchemas` now uses the async `addSchemaAsync` / `addForeignKeyAsync` / `addIndexAsync` variants. In `mqdb-wasm@0.3.1` the sync variants throw `"sync operations require memory backend"` on persistent DBs, which broke every entity config with `indexes`.
- **`loadScope` silent under subscribers.** `memory.loadScope` now calls `notifySubscribers` for every loaded entity after the DB swap. Previously consumers that subscribed before `replaceScope` resolved would see stale empty snapshots until an unrelated state change forced a re-read.
- **Concurrent `initialize()` race.** `Store.initialize` caches an in-flight `_initPromise`; simultaneous callers (React StrictMode, nested providers) now share one init instead of creating a second persistence layer that orphans already-migrated subscribers.
- **Root entity subscription coverage.** `memory.allEntities` now includes the root entity, with `listRecords` / `create` / `handleChangeEvent` branching on root vs. child. Previously `subscribeToEntity('project', …)` silently dropped mutations on the root.
- **IndexedDB connection leaks between tests/stores.** `persistence-layer.close()` now calls `Database.free()` before nulling `db`, so subsequent `deleteDatabase` calls no longer block.

### Deprecated (slated for removal in 0.3)

- `StitchProvider` (React), `SyncStoreProvider`, `StitchContext`, `StitchContextValue`, `useStitch`, `SyncStoreContext`, `SyncStoreContextValue`, `useSyncStore`, `usePersistenceToMemorySync` — all superseded by `<StoreProvider>` + `<AuthProvider>`.
- `StitchRoot` (Vue) — superseded by `<StoreRoot>` + `<StitchAuth>`.
- `createPersistenceStore`, `PersistenceStore` — superseded by `createStore` + `Store`.

## 0.1.0

Initial internal release.
