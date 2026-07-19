# Upgrading to 0.5.0

0.5.0 moves the entire store engine — the in-memory store, IndexedDB persistence,
MQTT sync, offline queue, and reconciliation — into the Rust/WASM package
[`@laboverwire/stitch-wasm`](https://www.npmjs.com/package/@laboverwire/stitch-wasm).
`@laboverwire/stitch` is now a thin binding layer over it.

This is a breaking release. The two changes that affect **every** app are the Vite
plugins (step 1) and the `remote` option shape (step 2); the rest apply only if you
used the specific API involved. `createStore(config, options)`, the `StoreConfig`
shape, the scope model, and the entire React/Vue binding surface
(`StoreProvider`/`AuthProvider` + hooks, `StoreRoot`/`StitchAuth` + composables)
are unchanged.

## 1. Add the WASM Vite plugins (required)

`stitch-wasm` ships as a `wasm-bindgen` bundler-target ESM module, so your bundler
must load a WASM ESM import. Install the two plugins and set the build target:

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
  build: { target: 'esnext' }, // the wasm module + plugin emit top-level await
});
```

If you previously excluded or filesystem-allowed the old WASM deps, **remove** that:

```ts
// delete these — they no longer apply:
optimizeDeps: { exclude: ['mqdb-wasm', 'mqtt5-wasm'] },
```

See [Vite consumer guide](./vite-consumer.md) for the source-alias/monorepo variant.

## 2. Update the `remote` option shape

The `remote` block changed, and its auth field changed from a *function* to a
*resolved value*:

```ts
// Before (0.4.x)
createStore(config, {
  persistence: { dbName: 'my-app' },
  remote: {
    serverUrl: 'wss://mqtt.example.com',
    getTicket: async () => fetchAuthTicket(), // a function
  },
});

// After (0.5.0)
createStore(config, {
  persistence: { dbName: 'my-app', passphrase }, // passphrase optional (AES-GCM)
  remote: {
    url: 'wss://mqtt.example.com',
    ticket: await fetchAuthTicket(),            // a resolved JWT string
    // or: username, password for classic MQTT auth
  },
});
```

Resolve the ticket **before** calling `createStore`. Ticket *refresh* on
wake-from-background is unchanged: it still flows through the provider's
`getTicket` prop (`<StoreProvider serverUrl=… getTicket=… >` /
`<StoreRoot :server-url :get-ticket>`), and `store.reconnect(serverUrl, getTicket?)`
keeps its signature.

## 3. Replace `OwnershipError` / `MqdbError` handling

Both classes were removed. Error checks that used `instanceof` must inspect the
error another way:

```ts
// Before
try { await store.update(entity, id, fields); }
catch (e) { if (e instanceof OwnershipError) redirectToLogin(); }

// After — match on the error message/shape surfaced by the wasm store
try { await store.update(entity, id, fields); }
catch (e) { if (String((e as Error)?.message).includes('ownership')) redirectToLogin(); }
```

## 4. Reimplement session/auth-cache helpers in your app

These six `Store` methods were removed: `getCachedUser`, `setCachedUser`,
`clearCachedUser`, `hasPendingLogout`, `setPendingLogout`, `flushPendingLogout`.
They were thin `sessionStorage` wrappers. If you used them, move the caching into
your own app code:

```ts
// Example replacement for the cached-user pair
const CACHE_KEY = 'my-app-cached-user';
const getCachedUser = () => JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
const setCachedUser = (u: unknown) => sessionStorage.setItem(CACHE_KEY, JSON.stringify(u));
```

## 5. Drop internal factory and layer-type imports

Only `createStore` is exported now. Remove any imports of the internal factories
or layer interfaces:

```ts
// removed — delete these imports
import {
  createMemoryStore, createSyncEngine, createPersistenceLayer,
  createRemoteSyncLayer, createPersistentOfflineQueue, createInMemoryOfflineQueue,
} from '@laboverwire/stitch';
import type {
  SyncEngine, PersistenceLayer, RemoteSyncLayer, OfflineQueue,
  MutationSender, LocalAccessor, PendingMutation, ConsolidatedMutation,
  ScopeBundle, ScopeState, SyncMutation, MutationEvent,
} from '@laboverwire/stitch';
```

The exported type surface is now: `StoreConfig`, `EntityDefinition`, `SchemaField`,
`ForeignKeyDefinition`, `ConnectionStatus`, `SortField`, `SortDirection`,
`ListFilter`, `Store`, `StoreOptions`, `PersistenceConfig`, `RemoteConfig`,
`MemoryStore`, `EntitySchema`, `DefaultSchema`, `EntityKey`, `OriginTag`. The
`MemoryStore` type is trimmed to `{ getSnapshot, getSnapshotAsMap, subscribeToScope }`.

## 6. Account for behavioural changes

- **Subscription callbacks are now asynchronous.** `subscribeToEntity` /
  `subscribeToScope` callbacks fire one tick after the mutating call resolves, not
  synchronously. Code that assumed a callback had already run by the time
  `create` / `update` / `delete` returned must `await` a tick (or react to the
  callback) instead.
- **A few signatures changed shape.** `getChildCount` is now synchronous (returns
  `number`); `disconnect`, `resetForLogout`, `loadScope`, and `clearScope` now
  return `Promise<void>`. These are usually source-compatible (`await` on a
  non-promise is a no-op; calling an async method without `await` still works), but
  the TypeScript types changed. `connectionStatus` is unchanged — still the
  lowercase union `'connected' | 'connecting' | 'disconnected' | 'error' | 'offline'`.

## 7. Remove direct `mqdb-wasm` / `mqtt5-wasm` dependencies

If your `package.json` listed either directly, remove them — they are bundled
inside `@laboverwire/stitch-wasm` and no longer installed transitively.

---

For the full list of changes, see the [0.5.0 changelog entry](../CHANGELOG.md).
