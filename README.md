# @laboverwire/stitch

Reactive state synchronization library. Bridges an in-memory store, IndexedDB persistence, and MQTT-based remote sync into a single `Store` interface. Ships framework bindings for React and Vue 3.

## Install

```bash
npm install @laboverwire/stitch
```

Optional peer dependencies (install whichever framework you use):

```bash
npm install react@^19.0.0    # for React bindings
npm install vue@^3.3.0       # for Vue bindings
```

## Quick Start (React)

```tsx
import { createStore } from '@laboverwire/stitch';
import type { StoreConfig } from '@laboverwire/stitch';
import {
  StoreProvider,
  AuthProvider,
  useStore,
  useEntitySnapshot,
  useSyncScope,
} from '@laboverwire/stitch/react';

interface Project { id: string; name: string }
interface Task { id: string; projectId: string; title: string; done: boolean }
type Schema = { project: Project; task: Task };

const config: StoreConfig = {
  entities: {
    project: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    },
    task: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'projectId', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'done', type: 'boolean' },
      ],
      foreignKeys: [{ field: 'projectId', references: 'project', onDelete: 'cascade' }],
      indexes: ['projectId'],
    },
  },
  scope: {
    rootEntity: 'project',
    childEntities: ['task'],
    scopeField: 'projectId',
  },
};

const store = createStore<Schema>(config, {
  persistence: { dbName: 'my-app' },
  remote: { serverUrl: 'wss://mqtt.example.com', getTicket: () => fetchAuthTicket() },
});

function App() {
  return (
    <StoreProvider store={store}>
      <AuthProvider store={store} userId="user-123">
        <ProjectView scopeId="project-abc" />
      </AuthProvider>
    </StoreProvider>
  );
}

function ProjectView({ scopeId }: { scopeId: string }) {
  const { store } = useStore();
  const { syncing, openScope } = useSyncScope(store, scopeId);
  const tasks = useEntitySnapshot(store, scopeId, 'task');

  useEffect(() => { void openScope(); }, [openScope]);

  if (syncing) return <div>Loading…</div>;
  return (
    <ul>
      {tasks.map((t) => <li key={t.id}>{t.title}</li>)}
    </ul>
  );
}
```

Because `createStore<Schema>()` is generic, `tasks` above is typed as `Task[]` — no `as string` casts per field.

## Quick Start (Vue 3)

```vue
<script setup lang="ts">
import { createStore } from '@laboverwire/stitch';
import type { StoreConfig } from '@laboverwire/stitch';
import { StoreRoot, StitchAuth } from '@laboverwire/stitch/vue';

type Schema = { project: Project; task: Task };

const config: StoreConfig = { /* same as React example */ };
const store = createStore<Schema>(config, {
  persistence: { dbName: 'my-app' },
  remote: { serverUrl: 'wss://mqtt.example.com', getTicket: () => fetchAuthTicket() },
});
</script>

<template>
  <StoreRoot :store="store">
    <StitchAuth :store="store" user-id="user-123">
      <ProjectView scope-id="project-abc" />
    </StitchAuth>
  </StoreRoot>
</template>
```

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useStore, useEntitySnapshot, useSyncScope } from '@laboverwire/stitch/vue';

const props = defineProps<{ scopeId: string }>();
const { store } = useStore();
const { syncing, openScope } = useSyncScope(store, () => props.scopeId);
const tasks = useEntitySnapshot(store, () => props.scopeId, 'task');

onMounted(() => { void openScope(); });
</script>

<template>
  <div v-if="syncing">Loading…</div>
  <ul v-else>
    <li v-for="t in tasks" :key="t.id">{{ t.title }}</li>
  </ul>
</template>
```

## Configuration

### `StoreConfig`

| Field | Type | Description |
|---|---|---|
| `entities` | `Record<string, EntityDefinition>` | Entity schemas (fields, foreign keys, indexes, unique constraints) |
| `scope.rootEntity` | `string` | Top-level entity type (e.g. `'project'`) |
| `scope.childEntities` | `string[]` | Entity types scoped under the root |
| `scope.scopeField` | `string` | Field on children referencing root's `id` |
| `topLevelEntities` | `Array<{ entity, subscriptionPattern }>` | Entities synced globally, not scoped |
| `localOnlyEntities` | `Record<string, EntityDefinition>` | Entities that never touch MQTT |
| `syncTopicPrefix` | `string` | MQTT topic prefix (default: `$DB`) |
| `responseTopicPrefix` | `string` | MQTT response prefix (default: `$SYS/responses`) |
| `versionField` | `string` | Field name for optimistic version tracking |
| `updatedAtField` | `string` | Field name for last-updated timestamp |
| `userScopeField` | `string` | Field name for user-level scoping |

### `StoreOptions`

| Field | Type | Description |
|---|---|---|
| `persistence` | `{ dbName: string }` | Enable IndexedDB persistence |
| `remote` | `{ serverUrl: string, getTicket?: () => Promise<string> }` | Enable MQTT sync with optional JWT auth |

### Scope Model

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

## Framework Integration

### React

#### Providers

Split into two:

- **`<StoreProvider>`** — store lifecycle only. Initializes the store, tracks connection status, handles visibility-change reconnection.
- **`<AuthProvider>`** — binds auth state. Sets `userId`, session-invalid and reconnect-validator handlers, and tears the store down via `resetForLogout()` when `authenticated` flips to false.

Compose them; nest `<AuthProvider>` inside `<StoreProvider>`:

```tsx
<StoreProvider store={store} serverUrl="wss://mqtt.example.com" getTicket={fetchAuthTicket}>
  <AuthProvider
    store={store}
    userId={user?.id}
    authenticated={!!user}
    onSessionInvalid={() => logout()}
    onReconnectValidate={() => validateSession()}
  >
    {children}
  </AuthProvider>
</StoreProvider>
```

`<StitchProvider>` (legacy two-store composition) still exists but is `@deprecated` and will be removed in 0.3.

#### Hooks

| Hook | Description |
|---|---|
| `useStore()` | Access `Store` instance and connection state from `<StoreProvider>` |
| `useEntitySnapshot(store, scopeId, entity)` | Reactive array of all records for an entity within a scope |
| `useEntitySnapshotAsMap(store, scopeId, entity)` | Same, as a `Record<id, record>` map |
| `useSyncScope(store, scopeId)` | Returns `{ syncing, syncError, openScope, closeScope }`; `openScope` internally calls `store.replaceScope` |
| `useScopedEntities(store, scopeId, entity)` | Async-loaded scoped entities: `{ data, loading, error, refetch }` |
| `useConnectionStatus(store)` | Current MQTT connection status |
| `useRootEntityList(store)` | List all root entities: `{ items, loading, error, refetch }` |
| `useChildCounts(store, entity)` | Map of `scopeId → count` for a child entity |
| `useTopLevelEntities(store, entity)` | List globally-synced entities: `{ items, loading }` |

Deprecated: `useStitch()`, `usePersistenceToMemorySync()` — will be removed in 0.3.

### Vue 3

#### Providers

Same split as React:

- **`<StoreRoot>`** — store lifecycle only.
- **`<StitchAuth>`** — auth binding.

```vue
<StoreRoot :store="store" server-url="wss://mqtt.example.com" :get-ticket="fetchAuthTicket">
  <StitchAuth
    :store="store"
    :user-id="userId"
    :authenticated="!!userId"
    :on-session-invalid="() => logout()"
    :on-reconnect-validate="() => validateSession()"
  >
    <slot />
  </StitchAuth>
</StoreRoot>
```

`<StitchRoot>` still exists but is `@deprecated` and will be removed in 0.3.

#### Composables

| Composable | Description |
|---|---|
| `useStore()` | Access `Store` instance and connection state |
| `useEntitySnapshot(store, scopeId, entity)` | `ShallowRef` of records array; params accept `MaybeRefOrGetter` |
| `useEntitySnapshotAsMap(store, scopeId, entity)` | Same as above, as a `Record<id, record>` map |
| `useSyncScope(store, scopeId)` | Returns `{ syncing, syncError, openScope, closeScope }` as shallow refs |
| `useConnectionStatus(store)` | `ShallowRef<ConnectionStatus>` |
| `useRootEntityList(store)` | `{ items, loading, error, refetch }` as shallow refs |
| `useScopedEntities(store, scopeId, entity)` | `{ data, loading, error, refetch }` as shallow refs |
| `useChildCounts(store, entity)` | `ShallowRef<Map<scopeId, count>>` |
| `useTopLevelEntities(store, entity)` | `{ items, loading }` as shallow refs |

## Store API

### Lifecycle

```ts
store.initialize()          // idempotent: concurrent callers share one init promise
store.destroy()             // tear down all layers
store.ready                 // boolean, true after initialization
```

### CRUD

```ts
store.create(entity, scopeId, data, tag?)   // returns Promise<id>
store.update(entity, id, fields, tag?)      // partial update
store.delete(entity, id, tag?)              // delete by id
```

### Queries

```ts
store.read(entity, id)                       // single record or null (sync, from memory)
store.getSnapshot(entity, scopeId)           // all records for entity in scope (sync)
store.getSnapshotAsMap(entity, scopeId)      // same as map keyed by id (sync)
store.list(entity, filter?)                  // filtered list from persistence (async)
store.listRootEntities(sort?)                // all root entities (async)
store.getChildCount(entity, scopeId)         // count children in scope (async)
```

### Subscriptions

```ts
store.subscribeToScope(scopeId, entity, cb)   // fires when the given scope+entity changes; callback: () => void
store.subscribeToEntity(entity, cb)           // fires on every create/update/delete; callback: (data | null, op) => void
```

Both return an unsubscribe function.

### Batch Operations

```ts
store.beginBatch()    // start batching mutations (defers subscriber notifications)
store.endBatch()      // flush batch and notify subscribers
```

### Scope Management

```ts
store.replaceScope(scopeId)                   // subscribe MQTT + fetch + reconcile + load (rebuilds memory DB)
store.closeScope(scopeId)                     // unsubscribe + clear in-memory data
store.loadScope(scopeId, data)                // manually load scope data (no network)
store.clearScope(scopeId)                     // clear in-memory scope data
```

### Connection

```ts
store.connectionStatus                        // current ConnectionStatus
store.isReconnecting                          // boolean
store.subscribeToConnectionStatus(cb)         // returns unsubscribe
store.disconnect()                            // close MQTT connection
store.reconnect(serverUrl, getTicket?)        // reconnect with new credentials
```

### Authentication & Session

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

### Local State

```ts
store.readLocalState(entity, id)              // read from local-only entities
store.updateLocalState(entity, id, fields)    // write to local-only entities
```

### Advanced

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

## Key Concepts

### Origin Tags

Mutations carry an `originTag` controlling propagation:

- `null`/`undefined` — local user mutation, propagated everywhere (memory → persistence → MQTT)
- `'remote'` — from network, skips persistence write (prevents loops)
- `'load'` — from scope loading, skips persistence write
- `'clear'` — scope clearing operation

### Offline Queue

Local mutations are queued in `pending_sync` and flushed when connected. Before flushing, mutations are consolidated:

- Multiple updates to same entity → merged (last write wins per field)
- Insert + updates → single insert with merged data
- Insert + delete → just delete

### Reconciliation

On reconnect or scope replace, server state is compared with local:

- Server records not found locally → created locally
- Local records not on server → deleted (unless pending insert in queue)
- Records with pending local updates → local version kept

### Connection Resilience

- Exponential backoff: `min(1000 * 2^n, 30000)ms` with 25% jitter for 5 attempts, then 15s intervals
- Auth errors cancel reconnection entirely
- Tab visibility: if hidden >30s and disconnected, auto-reconnect triggers on return

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Current version is `0.2.0`; it includes breaking changes from `0.1.x` — notably `openScope` → `replaceScope`, `StoreConfig.dbName` removal, subscribe-primitive consolidation, and a provider split.

## Architecture

For the internal design — how layers compose, data flow, subscription machinery, concurrency, corruption recovery, and the invariants each layer depends on — see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Current Status

Consumed as raw TypeScript via Vite aliases (`allowImportingTsExtensions`). Not yet published to npm. All internal imports use `.ts`/`.tsx` extensions.

To type-check:

```bash
npx tsc --noEmit
```

## Testing

The integration suite runs in real Chromium via Playwright so actual IndexedDB + WASM behavior is exercised:

```bash
npm test
```

See `examples/` for runnable vanilla-TS, React, and Vue apps — they double as reference implementations and smoke tests.

## Using from a Vite consumer

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
