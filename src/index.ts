export type {
  StoreConfig,
  EntityDefinition,
  SchemaField,
  ForeignKeyDefinition,
  MutationEvent,
  ScopeBundle,
  ScopeState,
  ConnectionStatus,
  SortField,
  SortDirection,
  ListFilter,
  SyncMutation,
  MemoryStore,
  SyncEngine,
  Store,
  StoreOptions,
  PersistenceConfig,
  RemoteConfig,
  PersistenceLayer,
  OfflineQueue,
  RemoteSyncLayer,
  LocalAccessor,
  MutationSender,
  PendingMutation,
  ConsolidatedMutation,
} from './types.ts';

/**
 * @deprecated Use {@link Store} (via {@link createStore}) instead. The legacy
 * `PersistenceStore` monolith will be removed in 0.3.
 */
export type { PersistenceStore } from './types.ts';

export { OwnershipError } from './types.ts';
export { MqdbError } from './internal-wasm-error.ts';

export { createMemoryStore } from './memory-store.ts';

/**
 * @deprecated Use {@link createStore} instead. `createPersistenceStore` is the legacy
 * monolithic two-store composition path and will be removed in 0.3.
 */
export { createPersistenceStore } from './persistence-store.ts';

export { createSyncEngine } from './sync-engine.ts';
export { createPersistenceBridge } from './persistence-bridge.ts';
export type { PersistenceBridge, PersistenceBridgeConfig } from './persistence-bridge.ts';

export { createStore } from './store.ts';
export { createPersistenceLayer } from './persistence-layer.ts';
export { createRemoteSyncLayer } from './remote-sync-layer.ts';
export { createPersistentOfflineQueue, createInMemoryOfflineQueue } from './offline-queue.ts';
