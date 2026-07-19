# @laboverwire/stitch

Reactive state synchronization for React and Vue. A thin, framework-agnostic binding layer over [`@laboverwire/stitch-wasm`](https://www.npmjs.com/package/@laboverwire/stitch-wasm) — a Rust/WASM package that owns the in-memory store, IndexedDB persistence, and MQTT-based remote sync. This package wraps that WASM `Store` in a small adapter and ships React and Vue 3 bindings on top; all store, sync, persistence, and offline-queue logic lives inside the WASM.

```bash
npm install @laboverwire/stitch
```

```ts
import { createStore } from '@laboverwire/stitch';

const store = createStore<Schema>(config, {
  persistence: { dbName: 'my-app' },
  remote: { url: 'wss://mqtt.example.com', ticket: await fetchAuthTicket() },
});

await store.initialize();
await store.replaceScope('project-abc');

const tasks = store.getSnapshot('task', 'project-abc');
```

`remote.url` is a `ws://`/`wss://` MQTT endpoint. Pass `ticket` (a JWT) for MQTT v5 enhanced auth, or `username`/`password` for classic password auth. A `persistence.passphrase` enables AES-GCM encryption of the IndexedDB store.

## Documentation

- [Configuration](./docs/configuration.md) — `StoreConfig`, `StoreOptions`, scope model, typed schemas
- [Store API](./docs/api.md) — full method reference
- [React bindings](./docs/react.md) — providers, hooks, runnable example
- [Vue 3 bindings](./docs/vue.md) — providers, composables, runnable example
- [Concepts](./docs/concepts.md) — origin tags, offline queue, reconciliation, connection resilience
- [Vite consumer guide](./docs/vite-consumer.md) — consuming apps must add `vite-plugin-wasm` (and `vite-plugin-top-level-await`) so the bundler can load the WASM module
- [Architecture](./ARCHITECTURE.md) — layer composition, data flow, invariants
- [Upgrading to 0.5.0](./docs/upgrading-to-0.5.md) — breaking changes and step-by-step upgrade from 0.4.x
- [Changelog](./CHANGELOG.md)
- [Releasing](./RELEASING.md)

`examples/` contains runnable vanilla-TS, React, and Vue apps that double as reference implementations.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
