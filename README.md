# @laboverwire/stitch

Reactive state synchronization library. Bridges an in-memory store, IndexedDB persistence, and MQTT-based remote sync into a single `Store` interface. Optional React and Vue 3 bindings.

```bash
npm install @laboverwire/stitch
```

```ts
import { createStore } from '@laboverwire/stitch';

const store = createStore<Schema>(config, {
  persistence: { dbName: 'my-app' },
  remote: { serverUrl: 'wss://mqtt.example.com', getTicket: () => fetchAuthTicket() },
});

await store.initialize();
await store.replaceScope('project-abc');

const tasks = store.getSnapshot('task', 'project-abc');
```

## Documentation

- [Configuration](./docs/configuration.md) — `StoreConfig`, `StoreOptions`, scope model, typed schemas
- [Store API](./docs/api.md) — full method reference and error handling
- [React bindings](./docs/react.md) — providers, hooks, runnable example
- [Vue 3 bindings](./docs/vue.md) — providers, composables, runnable example
- [Concepts](./docs/concepts.md) — origin tags, offline queue, reconciliation, connection resilience
- [Vite consumer guide](./docs/vite-consumer.md) — using the package via source alias from a monorepo
- [Architecture](./ARCHITECTURE.md) — internal layer composition, data flow, invariants
- [Changelog](./CHANGELOG.md)
- [Releasing](./RELEASING.md)

`examples/` contains runnable vanilla-TS, React, and Vue apps that double as reference implementations.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
