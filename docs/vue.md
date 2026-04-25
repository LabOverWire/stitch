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

## Providers

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

## Composables

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
