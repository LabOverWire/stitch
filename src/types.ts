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

export interface PersistenceConfig {
  dbName: string;
  passphrase?: string;
}

export interface RemoteConfig {
  url: string;
  clientId?: string;
  ticket?: string;
  username?: string;
  password?: string;
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

/**
 * Read-only view over the in-memory cache, exposed for `useSyncExternalStore`-style
 * subscriptions. Snapshots are referentially stable until the scope's version changes.
 */
export interface MemoryStore {
  getSnapshot(entity: string, scopeId: string): Record<string, unknown>[];
  getSnapshotAsMap(entity: string, scopeId: string): Record<string, Record<string, unknown>>;
  subscribeToScope(scopeId: string, entity: string, callback: () => void): () => void;
}

export interface Store<S extends EntitySchema = DefaultSchema> {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  readonly ready: boolean;

  read<K extends EntityKey<S>>(entity: K, id: string): S[K] | null;
  getSnapshot<K extends EntityKey<S>>(entity: K, scopeId: string): S[K][];
  getSnapshotAsMap<K extends EntityKey<S>>(entity: K, scopeId: string): Record<string, S[K]>;

  list<K extends EntityKey<S>>(entity: K, filter?: ListFilter): Promise<S[K][]>;
  listRootEntities(sort?: SortField[]): Promise<Record<string, unknown>[]>;
  getChildCount<K extends EntityKey<S>>(entity: K, scopeId: string): number;
  getVersion<K extends EntityKey<S>>(scopeId: string, entity: K): number;

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

  replaceScope(scopeId: string): Promise<void>;
  closeScope(scopeId: string): Promise<void>;
  loadScope(scopeId: string, data: Record<string, Record<string, unknown>[]>): Promise<void>;
  clearScope(scopeId: string): Promise<void>;

  readonly connectionStatus: ConnectionStatus;
  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void;
  disconnect(): Promise<void>;
  reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void>;
  readonly isReconnecting: boolean;

  setAuthenticatedUser(userId: string): void;
  setSessionInvalidHandler(handler: () => void): void;
  setReconnectValidator(validator: () => Promise<void>): void;
  resetForLogout(): Promise<void>;

  readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null>;
  updateLocalState(entity: string, id: string, fields: Record<string, unknown>): Promise<void>;
  pendingMutationCount(scopeId: string): Promise<number>;

  request(topic: string, payload: unknown): Promise<Record<string, unknown>>;

  readonly hasPersistence: boolean;
  readonly hasRemote: boolean;

  readonly memory: MemoryStore;
  readonly config: StoreConfig;
}
