# Vue 3 bindings

```bash
npm install vue@^3.3.0
```

## Quick start

```vue
<script setup lang="ts">
import { createStore } from '@laboverwire/stitch';
import type { StoreConfig } from '@laboverwire/stitch';
import { StoreRoot, StitchAuth } from '@laboverwire/stitch/vue';

interface Project { id: string; name: string }
interface Task { id: string; projectId: string; title: string; done: boolean }
type Schema = { project: Project; task: Task };

const authTicket = '<jwt-ticket>';

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
  remote: { url: 'wss://mqtt.example.com', ticket: authTicket },
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

`StoreOptions` takes two optional blocks:

- `persistence: { dbName, passphrase? }` — IndexedDB persistence; a `passphrase` turns on AES-GCM encryption at rest.
- `remote: { url, clientId?, ticket?, username?, password? }` — `url` is a `ws://`/`wss://` MQTT endpoint. `ticket` is a JWT for MQTT v5 enhanced auth; supply `username`/`password` instead for classic MQTT password auth.

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

## Providers

- **`<StoreRoot>`** — store lifecycle only. Initializes the store, tracks connection status, handles visibility-change reconnection.
- **`<StitchAuth>`** — auth binding. Sets the authenticated user, session-invalid and reconnect-validator handlers, and tears the store down via `resetForLogout()` when `authenticated` flips to false.

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

`server-url` / `get-ticket` on `<StoreRoot>` feed the wake-from-background reconnect path; `get-ticket` re-resolves the JWT before each `store.reconnect(serverUrl, getTicket)` call.

## Composables

| Composable | Description |
|---|---|
| `useStore()` | Access `Store` instance and connection state |
| `useEntitySnapshot(store, scopeId, entity)` | `ShallowRef` of records array; params accept `MaybeRefOrGetter` |
| `useEntitySnapshotAsMap(store, scopeId, entity)` | Same as above, as a `Record<id, record>` map |
| `useSyncScope(store, scopeId)` | Returns `{ syncing, syncError, openScope, closeScope }` as shallow refs; `openScope` internally calls `store.replaceScope` |
| `useConnectionStatus(store)` | `ShallowRef<ConnectionStatus>` |
| `useRootEntityList(store)` | `{ items, loading, error, refetch }` as shallow refs |
| `useScopedEntities(store, scopeId, entity)` | `{ data, loading, error, refetch }` as shallow refs |
| `useChildCounts(store, entity)` | `ShallowRef<Map<scopeId, count>>` |
| `useTopLevelEntities(store, entity)` | `{ items, loading }` as shallow refs |

## Mount-before-init safety

The underlying wasm store requires `initialize()` before use, but the binding layer tolerates access before that resolves: synchronous reads return empties (`[]` / `{}` / `null` / `0` / `'offline'`) and subscriptions defer wiring until initialization completes, then fire once so consumers re-read. Composables are therefore safe to use in components that mount before `<StoreRoot>` has finished initializing — no manual `ready` guards needed. Subscription callbacks (`subscribeToScope` / `subscribeToEntity`) are also delivered asynchronously, one tick after the mutating call resolves.

## Vite setup

`@laboverwire/stitch` wraps `@laboverwire/stitch-wasm`, a `wasm-bindgen` bundler-target ESM module. A consuming Vite app **must** add `vite-plugin-wasm` and `vite-plugin-top-level-await`; without them the wasm module fails to instantiate. See [Using from a Vite consumer](./vite-consumer.md) for the full config.
