# Configuration

## `StoreConfig`

| Field | Type | Description |
|---|---|---|
| `entities` | `Record<string, EntityDefinition>` | Entity schemas (fields, foreign keys, indexes, unique constraints) |
| `scope.rootEntity` | `string` | Top-level entity type (e.g. `'project'`) |
| `scope.childEntities` | `string[]` | Entity types scoped under the root |
| `scope.scopeField` | `string` | Field on children referencing root's `id` |
| `topLevelEntities` | `Array<{ entity, subscriptionPattern }>` | Entities synced globally, not scoped |
| `localOnlyEntities` | `Record<string, EntityDefinition>` | Entities that never touch MQTT |
| `syncTopicPrefix` | `string` | MQTT topic prefix (default: `$DB`) |
| `responseTopicPrefix` | `string` | MQTT response inbox prefix (default: `$DB/clients`). Per-request response topic is `{prefix}/{clientId}/{requestId}` |
| `versionField` | `string` | Field name for optimistic version tracking |
| `updatedAtField` | `string` | Field name for last-updated timestamp |
| `userScopeField` | `string` | Field name for user-level scoping |

## `StoreOptions`

| Field | Type | Description |
|---|---|---|
| `persistence` | `{ dbName: string, passphrase?: string }` | Enable IndexedDB persistence. A `passphrase` turns on AES-GCM encryption at rest |
| `remote` | `{ url: string, clientId?: string, ticket?: string, username?: string, password?: string, autoConnect?: boolean }` | Enable MQTT sync. `url` is a `ws://`/`wss://` MQTT endpoint; `ticket` is a JWT for MQTT v5 enhanced auth; `username`/`password` drive classic MQTT password auth. `autoConnect` (default `true`) → set `false` to skip the connect on `initialize()` and drive it yourself via `reconnect(url, ticket)`, the usual pattern when the JWT is minted dynamically per connection |

## Scope model

A **scope** is an instance of the root entity. Replacing the active scope subscribes to MQTT topics, fetches root + children from the server, reconciles with local data, and rebuilds the in-memory store.

- The root entity's `id` **is** the `scopeId`
- Child entities reference the root via `scopeField`
- `replaceScope(scopeId)` loads server data and starts real-time sync — the in-memory WASM DB is rebuilt on each call, so only one scope is live at a time
- `closeScope(scopeId)` unsubscribes and clears in-memory data

## Typed schemas

`createStore` accepts a generic type parameter mapping entity names to record types:

```ts
interface Project { id: string; name: string; createdAt: number }
interface Task { id: string; projectId: string; title: string; done: boolean }

type Schema = { project: Project; task: Task };

const store = createStore<Schema>(config, options);

const project: Project | null = store.read('project', id);
const tasks: Task[] = store.getSnapshot('task', scopeId);

store.subscribeToEntity('task', (data, op) => {
  // data: Task | null, op: 'insert' | 'update' | 'delete'
});
```

Without the generic, every method falls back to `Record<string, unknown>`.
