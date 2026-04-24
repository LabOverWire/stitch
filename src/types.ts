export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
}

export interface ForeignKeyDefinition {
  field: string;
  references: string;
  onDelete: 'cascade' | 'set_null' | 'restrict';
}

export interface EntityDefinition {
  fields: SchemaField[];
  foreignKeys?: ForeignKeyDefinition[];
  uniqueConstraints?: string[][];
  indexes?: string[];
}

export interface StoreConfig {
  entities: Record<string, EntityDefinition>;
  scope: {
    rootEntity: string;
    childEntities: string[];
    scopeField: string;
  };
  topLevelEntities?: Array<{
    entity: string;
    subscriptionPattern: string;
  }>;
  localOnlyEntities?: Record<string, EntityDefinition>;
  syncTopicPrefix?: string;
  responseTopicPrefix?: string;
  versionField?: string;
  updatedAtField?: string;
  userScopeField?: string;
}

export type OriginTag = 'remote' | 'load' | 'clear';

export interface MutationEvent {
  operation: 'create' | 'update' | 'delete';
  entity: string;
  id: string;
  scopeId: string;
  data: Record<string, unknown> | null;
  originTag: OriginTag | null;
}

export interface ScopeBundle {
  root: Record<string, unknown> | null;
  children: Record<string, Record<string, unknown>[]>;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'offline';

export type SortDirection = 'asc' | 'desc';

export interface SortField {
  field: string;
  direction: SortDirection;
}

export interface ListFilter {
  scopeId?: string;
  sort?: SortField[];
  projection?: string[];
}

export interface SyncMutation {
  op: 'insert' | 'update' | 'delete';
  entity: string;
  id: string;
  data: Record<string, unknown> | null;
  operationId: string | null;
}

export interface ScopeState {
  root: Record<string, unknown>;
  children: Record<string, Record<string, unknown>[]>;
  version: number;
  bufferedMutations: SyncMutation[];
}

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export interface MemoryStore {
  ensureReady(): Promise<void>;
  readonly isReady: boolean;
  readonly corrupted: boolean;
  onCorruption(callback: () => void): () => void;

  create(entity: string, scopeId: string, data: Record<string, unknown>, tag?: OriginTag): void;
  update(entity: string, id: string, fields: Record<string, unknown>, tag?: OriginTag): void;
  delete(entity: string, id: string, tag?: OriginTag): void;
  read(entity: string, id: string): Record<string, unknown> | null;
  list(entity: string, scopeId: string): Record<string, unknown>[];

  getSnapshot(entity: string, scopeId: string): Record<string, unknown>[];
  getSnapshotAsMap(entity: string, scopeId: string): Record<string, Record<string, unknown>>;

  subscribeToScope(scopeId: string, entity: string, callback: () => void): () => void;
  subscribeToEntity(entity: string, callback: () => void): () => void;
  onMutation(listener: (event: MutationEvent) => void): () => void;

  beginBatch(): void;
  endBatch(): void;

  loadScope(
    scopeId: string,
    data: Record<string, Record<string, unknown>[]>,
    tag?: OriginTag
  ): void;
  clearScope(scopeId: string): void;

  onReady(callback: () => void): void;
  getLastOriginTag(): OriginTag | null;
}

export interface PersistenceLayer {
  open(dbName: string): Promise<void>;
  close(): void;

  create(entity: string, data: Record<string, unknown>): Promise<void>;
  read(entity: string, id: string): Promise<Record<string, unknown>>;
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>;
  delete(entity: string, id: string): Promise<void>;
  list(entity: string, options?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  count(entity: string, options?: Record<string, unknown>): Promise<number>;

  subscribe(
    entity: string,
    callback: (data: unknown, op: 'insert' | 'update' | 'delete') => void
  ): () => void;

  readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null>;
  updateLocalState(entity: string, id: string, fields: Record<string, unknown>): Promise<void>;

  readonly isOpen: boolean;
}

export interface PendingMutation {
  op: 'insert' | 'update' | 'delete';
  entity: string;
  id: string;
  scopeId: string;
  data: Record<string, unknown> | null;
}

export interface ConsolidatedMutation extends PendingMutation {
  recordIds: string[];
}

export interface MutationSender {
  syncCreate(entity: string, scopeId: string, data: Record<string, unknown>): Promise<void>;
  syncUpdate(
    entity: string,
    scopeId: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void>;
  syncDelete(entity: string, scopeId: string, id: string): Promise<void>;
  readEntity(entity: string, id: string): Promise<Record<string, unknown>>;
  deleteEntity(entity: string, id: string): Promise<void>;
}

export interface OfflineQueue {
  queue(mutation: PendingMutation): Promise<void>;
  remove(entity: string, entityId: string, scopeId: string, op: string): Promise<void>;
  flush(sender: MutationSender): Promise<void>;
  clear(): Promise<void>;
  getPendingForScope(scopeId: string): Promise<PendingMutation[]>;
  hasPendingInsert(entity: string, entityId: string): Promise<boolean>;
}

export interface LocalAccessor {
  read(entity: string, id: string): Promise<Record<string, unknown>>;
  list(entity: string, options: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  create(entity: string, data: Record<string, unknown>): Promise<void>;
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>;
  delete(entity: string, id: string): Promise<void>;
}

export interface RemoteSyncLayer {
  connect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void>;
  disconnect(): void;
  reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void>;
  readonly isReconnecting: boolean;
  readonly connectionStatus: ConnectionStatus;
  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void;

  setAuthenticatedUser(userId: string): void;
  setSessionInvalidHandler(handler: () => void): void;
  setReconnectValidator(validator: () => Promise<void>): void;

  syncCreate(entity: string, scopeId: string, data: Record<string, unknown>): Promise<void>;
  syncUpdate(
    entity: string,
    scopeId: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void>;
  syncDelete(entity: string, scopeId: string, id: string): Promise<void>;

  openScope(scopeId: string): Promise<ScopeState>;
  closeScope(scopeId: string): Promise<void>;
  fetchList(
    entity: string,
    scopeId?: string,
    sort?: SortField[]
  ): Promise<Record<string, unknown>[] | null>;

  syncRootEntityList(localAccessor: LocalAccessor, queue: OfflineQueue | null): Promise<void>;
  reconcileChildren(
    scopeId: string,
    entity: string,
    serverRecords: Record<string, unknown>[],
    localAccessor: LocalAccessor,
    queue: OfflineQueue | null
  ): Promise<void>;
  applyMutationToDb(mutation: SyncMutation, localAccessor: LocalAccessor): Promise<void>;

  request(topic: string, payload: unknown): Promise<Record<string, unknown>>;

  resetForLogout(): void;
}

export interface PersistenceConfig {
  dbName: string;
}

export interface RemoteConfig {
  serverUrl: string;
  getTicket?: () => Promise<string>;
}

export interface StoreOptions {
  persistence?: PersistenceConfig;
  remote?: RemoteConfig;
}

/**
 * A schema maps entity name → record type. Users declare their own:
 *
 * ```ts
 * type Schema = { project: Project; task: Task };
 * const store = createStore<Schema>(config, options);
 * ```
 *
 * When no generic argument is supplied, methods fall back to `Record<string, unknown>`.
 */
export type EntitySchema = Record<string, object>;
export type DefaultSchema = Record<string, Record<string, unknown>>;
export type EntityKey<S extends EntitySchema> = keyof S & string;

export interface Store<S extends EntitySchema = DefaultSchema> {
  initialize(): Promise<void>;
  destroy(): void;
  readonly ready: boolean;

  read<K extends EntityKey<S>>(entity: K, id: string): S[K] | null;
  getSnapshot<K extends EntityKey<S>>(entity: K, scopeId: string): S[K][];
  getSnapshotAsMap<K extends EntityKey<S>>(entity: K, scopeId: string): Record<string, S[K]>;

  list<K extends EntityKey<S>>(entity: K, filter?: ListFilter): Promise<S[K][]>;
  listRootEntities(sort?: SortField[]): Promise<Record<string, unknown>[]>;
  getChildCount<K extends EntityKey<S>>(entity: K, scopeId: string): Promise<number>;

  create<K extends EntityKey<S>>(
    entity: K,
    scopeId: string,
    data: Partial<S[K]> & Record<string, unknown>,
    tag?: OriginTag
  ): Promise<string>;
  update<K extends EntityKey<S>>(
    entity: K,
    id: string,
    fields: Partial<S[K]>,
    tag?: OriginTag
  ): Promise<void>;
  delete<K extends EntityKey<S>>(entity: K, id: string, tag?: OriginTag): Promise<void>;

  subscribeToScope<K extends EntityKey<S>>(
    scopeId: string,
    entity: K,
    callback: () => void
  ): () => void;
  subscribeToEntity<K extends EntityKey<S>>(
    entity: K,
    callback: (data: S[K] | null, op: 'insert' | 'update' | 'delete') => void
  ): () => void;

  beginBatch(): void;
  endBatch(): void;

  /**
   * Load a scope's data into the in-memory store, replacing whatever scope was
   * previously active. Fetches the root entity and its children from persistence
   * (and the server, if remote sync is configured), reconciles with local state,
   * and subscribes to live mutations for the new scope.
   *
   * The in-memory WASM database is rebuilt on each call — only one scope is live
   * at a time. Use `closeScope(previousId)` before switching if you need a clean
   * teardown signal for the old scope.
   */
  replaceScope(scopeId: string): Promise<void>;
  closeScope(scopeId: string): Promise<void>;
  loadScope(scopeId: string, data: Record<string, Record<string, unknown>[]>): void;
  clearScope(scopeId: string): void;

  readonly connectionStatus: ConnectionStatus;
  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void;
  disconnect(): void;
  reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void>;
  readonly isReconnecting: boolean;

  setAuthenticatedUser(userId: string): void;
  setSessionInvalidHandler(handler: () => void): void;
  setReconnectValidator(validator: () => Promise<void>): void;
  resetForLogout(): void;

  readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null>;
  updateLocalState(entity: string, id: string, fields: Record<string, unknown>): Promise<void>;

  getCachedUser(): Promise<Record<string, unknown> | null>;
  setCachedUser(user: Record<string, unknown>): Promise<void>;
  clearCachedUser(): Promise<void>;
  hasPendingLogout(): Promise<boolean>;
  setPendingLogout(pending: boolean): Promise<void>;
  flushPendingLogout(logoutFn: () => Promise<void>): Promise<void>;

  request(topic: string, payload: unknown): Promise<Record<string, unknown>>;

  readonly hasPersistence: boolean;
  readonly hasRemote: boolean;

  readonly memory: MemoryStore;
  readonly config: StoreConfig;
}

export interface SyncEngine {
  connect(serverUrl: string, wasmModule: unknown, getTicket?: () => Promise<string>): Promise<void>;
  reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void>;
  disconnect(): void;
  readonly isReconnecting: boolean;

  setMutationHandler(handler: (scopeId: string, mutation: SyncMutation) => void): void;
  setConnectionStatusHandler(handler: (status: ConnectionStatus) => void): void;
  setSessionInvalidHandler(handler: () => void): void;

  openScope(scopeId: string): Promise<ScopeState>;
  closeScope(scopeId: string): Promise<void>;

  createEntity(
    entity: string,
    scopeId: string | null,
    data: Record<string, unknown>
  ): Promise<string>;
  updateEntity(
    entity: string,
    scopeId: string | null,
    id: string,
    data: Record<string, unknown>
  ): Promise<void>;
  deleteEntity(entity: string, scopeId: string | null, id: string): Promise<void>;

  fetchList(
    entity: string,
    scopeId?: string,
    sort?: SortField[]
  ): Promise<Record<string, unknown>[] | null>;

  bumpScopeVersion(scopeId: string): Promise<void>;

  request(topic: string, payload: unknown): Promise<Record<string, unknown>>;

  isSubscribedTo(scopeId: string): boolean;
  getAppliedVersion(scopeId: string): number;
}
