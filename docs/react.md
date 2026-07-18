# React bindings

```bash
npm install react@^19.0.0
```

The store backend ships as WebAssembly (`@laboverwire/stitch-wasm`), so a consuming
app's Vite config must enable `vite-plugin-wasm` and `vite-plugin-top-level-await`:

```ts
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  build: { target: 'esnext' },
});
```

## Quick start

```tsx
import { useEffect } from 'react';
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

const authTicket = '<jwt-ticket>';

const store = createStore<Schema>(config, {
  persistence: { dbName: 'my-app' },
  remote: { url: 'wss://mqtt.example.com', ticket: authTicket },
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
  const tasks = useEntitySnapshot(store, scopeId, 'task') as Task[];

  useEffect(() => { void openScope(); }, [openScope]);

  if (syncing) return <div>Loading…</div>;
  return (
    <ul>
      {tasks.map((t) => <li key={t.id}>{t.title}</li>)}
    </ul>
  );
}
```

The schema generic on `createStore<Schema>()` types the direct `Store<Schema>` methods
(`read`, `getSnapshot`, `list`, etc.), but it does **not** reach the snapshot hooks. The
entity-snapshot hooks are not schema-generic: `useEntitySnapshot(store, scopeId, 'task')`
returns `Record<string, unknown>[]` regardless of the store's schema, and `store` from
`useStore()` is a plain non-generic `Store`. Cast the hook result to your app's record type
(e.g. `as Task[]`) when you need field-level typing, as in the example above.

`remote.ticket` is a JWT for MQTT v5 enhanced auth; use `remote.username`/`remote.password`
for classic MQTT password auth instead. `remote.url` is a `ws://`/`wss://` endpoint. Passing
`persistence.passphrase` enables AES-GCM encryption of the local database.

## Pre-init tolerance

Hooks are safe to mount before the store finishes initializing. `<StoreProvider>` calls
`store.initialize()` on mount, but the adapter tolerates access before that resolves:
synchronous reads return empties (`[]` / `{}` / `null` / `0` / `'offline'`), and `subscribe*`
calls defer wiring until initialization completes and then trigger a re-read. You don't need
to gate hooks behind an "initialized" flag.

## Providers

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

The optional `serverUrl`/`getTicket` props on `<StoreProvider>` drive reconnect-on-wake:
after the tab has been hidden past the stale threshold, the provider calls
`store.reconnect(serverUrl, getTicket)`.

## Hooks

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
