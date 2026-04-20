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
  PersistenceStore,
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

export { OwnershipError } from './types.ts';

export { createMemoryStore } from './memory-store.ts';
export { createPersistenceStore } from './persistence-store.ts';
export { createSyncEngine } from './sync-engine.ts';
export { createPersistenceBridge } from './persistence-bridge.ts';
export type { PersistenceBridge, PersistenceBridgeConfig } from './persistence-bridge.ts';

export { createStore } from './store.ts';
export { createPersistenceLayer } from './persistence-layer.ts';
export { createRemoteSyncLayer } from './remote-sync-layer.ts';
export { createPersistentOfflineQueue, createInMemoryOfflineQueue } from './offline-queue.ts';
