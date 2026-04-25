# React bindings

```bash
npm install react@^19.0.0
```

## Quick start

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
