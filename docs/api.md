# Store API

`@laboverwire/stitch` is a thin binding layer over the `@laboverwire/stitch-wasm`
store. `createStore(config, options?)` returns a `Store`; all methods below are on
that instance.

## Lifecycle

```ts
store.initialize()          // must be awaited before use; returns Promise<void>
store.destroy()             // tear down the store; returns Promise<void>
store.ready                 // boolean, true after initialization
```

## Pre-init tolerance

The adapter tolerates access before `initialize()` resolves, so React/Vue hooks are
safe to mount before the provider finishes initializing:

- Synchronous reads return empties: `read` → `null`, `getSnapshot` → `[]`,
  `getSnapshotAsMap` → `{}`, `getChildCount` → `0`, `getVersion` → `0`,
  `connectionStatus` → `'offline'`, `isReconnecting` → `false`.
- `subscribe*` calls defer wiring until `initialize()` resolves, then poke a
  re-read so `useSyncExternalStore`-style consumers pick up the first snapshot.
- Async methods await initialization before running.

## CRUD

```ts
store.create(entity, scopeId, data, tag?)   // returns Promise<id>
store.update(entity, id, fields, tag?)      // partial update, Promise<void>
store.delete(entity, id, tag?)              // delete by id, Promise<void>
```

`tag` is an `OriginTag` (`'remote' | 'load' | 'clear'`).

## Queries

```ts
store.read(entity, id)                       // single record or null (sync, from memory)
store.getSnapshot(entity, scopeId)           // all records for entity in scope (sync)
store.getSnapshotAsMap(entity, scopeId)      // same as map keyed by id (sync)
store.list(entity, filter?)                  // filtered list (async)
store.listRootEntities(sort?)                // all root entities (async)
store.getChildCount(entity, scopeId)         // count children in scope (sync, returns number)
store.getVersion(scopeId, entity)            // reactivity token for the scope+entity (sync, returns number)
```

`getVersion` returns an opaque reactivity token the memory snapshot cache compares
for equality to decide when a snapshot must be re-read. It changes whenever the
scope+entity's data changes; treat it as opaque, not a sequential count.

## Subscriptions

```ts
store.subscribeToScope(scopeId, entity, cb)   // fires when the given scope+entity changes; callback: () => void
store.subscribeToEntity(entity, cb)           // fires on every create/update/delete; callback: (data | null, op) => void
```

Both return an unsubscribe function. Callbacks are delivered **asynchronously** —
one tick after the mutating call resolves, not synchronously.

## Batch operations

```ts
store.beginBatch()    // start batching mutations (defers subscriber notifications)
store.endBatch()      // flush batch and notify subscribers
```

## Scope management

```ts
store.replaceScope(scopeId)                   // subscribe + fetch + reconcile + load, rebuilds memory DB (async)
store.closeScope(scopeId)                     // unsubscribe + clear in-memory data (async)
store.loadScope(scopeId, data)                // manually load scope data, no network (async)
store.clearScope(scopeId)                     // clear in-memory scope data (async)
```

`loadScope` takes `data` as `Record<string, Record<string, unknown>[]>` (entity
name → array of records). All four return `Promise<void>`.

## Connection

```ts
store.connectionStatus                        // current ConnectionStatus (sync)
store.isReconnecting                          // boolean
store.subscribeToConnectionStatus(cb)         // returns unsubscribe
store.disconnect()                            // close connection, Promise<void>
store.reconnect(serverUrl, getTicket?)        // reconnect with new credentials, Promise<void>
```

`ConnectionStatus` is one of the lowercase values `'connected' | 'connecting' |
'disconnected' | 'error' | 'offline'`. `reconnect` runs any configured reconnect
validator, resolves the ticket via `getTicket`, and reconnects.

## Authentication & session

```ts
store.setAuthenticatedUser(userId)
store.setSessionInvalidHandler(handler)
store.setReconnectValidator(validator)
store.resetForLogout()                        // Promise<void>
```

## Local state & pending sync

```ts
store.readLocalState(entity, id)              // read from local-only entities (async)
store.updateLocalState(entity, id, fields)    // write to local-only entities (async)
store.pendingMutationCount(scopeId)           // pending offline mutations for scope, Promise<number>
```

## Advanced

```ts
store.request(topic, payload)                 // raw MQTT request-response (async)
store.hasPersistence                          // boolean
store.hasRemote                               // boolean
store.memory                                  // underlying MemoryStore view
store.config                                  // StoreConfig
```

`store.memory` is a read-only `MemoryStore` view exposing `getSnapshot`,
`getSnapshotAsMap`, and `subscribeToScope`.
