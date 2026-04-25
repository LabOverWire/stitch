# Store API

## Lifecycle

```ts
store.initialize()          // idempotent: concurrent callers share one init promise
store.destroy()             // tear down all layers
store.ready                 // boolean, true after initialization
```

## CRUD

```ts
store.create(entity, scopeId, data, tag?)   // returns Promise<id>
store.update(entity, id, fields, tag?)      // partial update
store.delete(entity, id, tag?)              // delete by id
```

## Queries

```ts
store.read(entity, id)                       // single record or null (sync, from memory)
store.getSnapshot(entity, scopeId)           // all records for entity in scope (sync)
store.getSnapshotAsMap(entity, scopeId)      // same as map keyed by id (sync)
store.list(entity, filter?)                  // filtered list from persistence (async)
store.listRootEntities(sort?)                // all root entities (async)
store.getChildCount(entity, scopeId)         // count children in scope (async)
```

## Subscriptions

```ts
store.subscribeToScope(scopeId, entity, cb)   // fires when the given scope+entity changes; callback: () => void
store.subscribeToEntity(entity, cb)           // fires on every create/update/delete; callback: (data | null, op) => void
```

Both return an unsubscribe function.

## Batch operations

```ts
store.beginBatch()    // start batching mutations (defers subscriber notifications)
store.endBatch()      // flush batch and notify subscribers
```

## Scope management

```ts
store.replaceScope(scopeId)                   // subscribe MQTT + fetch + reconcile + load (rebuilds memory DB)
store.closeScope(scopeId)                     // unsubscribe + clear in-memory data
store.loadScope(scopeId, data)                // manually load scope data (no network)
store.clearScope(scopeId)                     // clear in-memory scope data
```

## Connection

```ts
store.connectionStatus                        // current ConnectionStatus
store.isReconnecting                          // boolean
store.subscribeToConnectionStatus(cb)         // returns unsubscribe
store.disconnect()                            // close MQTT connection
store.reconnect(serverUrl, getTicket?)        // reconnect with new credentials
```

## Authentication & session

```ts
store.setAuthenticatedUser(userId)
store.setSessionInvalidHandler(handler)
store.setReconnectValidator(validator)
store.resetForLogout()

store.getCachedUser()                         // from sessionStorage (15min TTL)
store.setCachedUser(user)
store.clearCachedUser()

store.hasPendingLogout()
store.setPendingLogout(pending)
store.flushPendingLogout(logoutFn)
```

## Local state

```ts
store.readLocalState(entity, id)              // read from local-only entities
store.updateLocalState(entity, id, fields)    // write to local-only entities
```

## Advanced

```ts
store.request(topic, payload)                 // raw MQTT request-response
store.hasPersistence                          // boolean
store.hasRemote                               // boolean
store.memory                                  // underlying MemoryStore
store.config                                  // StoreConfig
```

## Errors

All throws from the underlying WASM layer are coerced into `MqdbError` so consumers get a real `Error` object with a `.stack`, a method-qualified message, and the original exception preserved on `.cause`:

```ts
import { MqdbError } from '@laboverwire/stitch';

try {
  await store.list('task', { sort: [{ field: 'bogus', direction: 'asc' }] });
} catch (err) {
  if (err instanceof MqdbError) {
    console.error(err.method);   // "list:task"
    console.error(err.message);  // "mqdb.list:task: unknown field: 'bogus'"
    console.error(err.cause);    // the raw WASM throw
  }
}
```
