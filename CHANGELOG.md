# Changelog

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
