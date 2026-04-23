import type { Database } from 'mqdb-wasm';
import type {
  StoreConfig,
  SyncMutation,
  ScopeBundle,
  ConnectionStatus,
  SortField,
  ListFilter,
  PersistenceStore,
} from './types.ts';
import { OwnershipError } from './types.ts';
import { createSyncEngine } from './sync-engine.ts';
import type { SyncEngine } from './types.ts';

type EntitySubscriptionCallback = (entity: unknown, op: 'insert' | 'update' | 'delete') => void;

interface PendingMutation {
  op: 'insert' | 'update' | 'delete';
  entity: string;
  id: string;
  scopeId: string;
  data: Record<string, unknown> | null;
}

function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value != null) {
      result[key] = value;
    }
  }
  return result;
}

function isTransientSyncError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /timeout|disconnected/i.test(err.message);
}

class PersistenceStoreImpl implements PersistenceStore {
  private db: Database | null = null;
  private sync: SyncEngine | null = null;
  private connectionStatus: ConnectionStatus = 'offline';
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private entitySubscriptions: Map<string, Set<EntitySubscriptionCallback>> = new Map();
  private wasmSubscriptionIds: Map<string, string> = new Map();
  private currentScopeId: string | null = null;
  private isFlushing = false;
  private initialized = false;
  private initializing = false;
  private sessionInvalidHandler: (() => void) | null = null;
  private reconnectValidator: (() => Promise<void>) | null = null;
  private dbRecovering = false;
  private _dbNeedsRecovery = false;
  private initialSyncDone = false;
  private authenticatedUser: string | null = null;
  private _opQueue: Promise<void> = Promise.resolve();
  private suppressEntityNotifications = false;
  private shuttingDown = false;
  private readonly config: StoreConfig;
  private readonly allSyncedEntities: string[];
  private readonly allLocalEntities: string[];

  constructor(config: StoreConfig) {
    this.config = config;
    this.allSyncedEntities = [
      config.scope.rootEntity,
      ...config.scope.childEntities,
      ...(config.topLevelEntities?.map((t) => t.entity) ?? []),
    ];
    this.allLocalEntities = Object.keys(config.localOnlyEntities ?? {});
  }

  notifyCorruption(): void {
    this._dbNeedsRecovery = true;
    this.serialized('proactiveRecovery', async () => {}).catch(() => {});
  }

  private serialized<T>(label: string, fn: () => Promise<T>, timeoutMs = 10000): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('Service shutting down'));
    const result = this._opQueue.then(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      if (this._dbNeedsRecovery) {
        this._dbNeedsRecovery = false;
        await this.recoverDb();
      }

      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this._dbNeedsRecovery = true;
          reject(new Error(`serialized('${label}') timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      return Promise.race([fn(), timeout]).finally(() => {
        clearTimeout(timer);
      });
    });
    this._opQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async initialize(serverUrl?: string, getTicket?: () => Promise<string>): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      if (!this.db) {
        const wasmMod = await import('mqdb-wasm');
        await wasmMod.default();
        this.db = await wasmMod.Database.openPersistent(this.config.dbName);
        await this.setupSchemas();
        this.setupWasmSubscriptions();
      }

      const clientId = this.getOrCreateClientId();
      const syncEngine = createSyncEngine(clientId, this.config);
      this.sync = syncEngine;

      syncEngine.setMutationHandler((_scopeId, mutation) => {
        this.handleRemoteMutation(mutation);
      });

      syncEngine.setSessionInvalidHandler(() => {
        this.handleSessionInvalid();
      });

      syncEngine.setConnectionStatusHandler((status) => {
        this.setConnectionStatus(status);
        if (status === 'connected') {
          this.flushPendingMutations()
            .then(() => this.syncRootEntityList())
            .catch((err) => console.error('[PersistenceStore] Sync/flush failed:', err));
          this.revalidateSessionOnReconnect();
        }
      });

      if (serverUrl) {
        try {
          const wasmModule = await import('mqtt5-wasm');
          await syncEngine.connect(serverUrl, wasmModule, getTicket);
        } catch (err) {
          console.warn('[PersistenceStore] Failed to connect, reconnecting in background:', err);
          this.initialSyncDone = true;
        }
      } else {
        this.setConnectionStatus('offline');
        this.initialSyncDone = true;
      }

      this.initialized = true;
      this.notifyAllEntitySubscribers();
    } finally {
      this.initializing = false;
    }
  }

  private notifyAllEntitySubscribers(): void {
    for (const entity of this.entitySubscriptions.keys()) {
      this.notifyEntitySubscribers(entity, null, 'update');
    }
  }

  setAuthenticatedUser(userId: string): void {
    this.authenticatedUser = userId;
  }

  disconnect(): void {
    this.sync?.disconnect();
    this.setConnectionStatus('offline');
  }

  isReconnecting(): boolean {
    return this.sync?.isReconnecting ?? false;
  }

  async reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    if (!this.sync) return;
    if (this.sync.isReconnecting) return;

    try {
      await this.sync.reconnect(serverUrl, getTicket);
    } catch (err) {
      console.warn('[PersistenceStore] Reconnect failed, working offline:', err);
      this.setConnectionStatus('offline');
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private async loadScopeInner(scopeId: string): Promise<ScopeBundle | null> {
    if (!this.db) return null;
    const { rootEntity, childEntities, scopeField } = this.config.scope;

    const root = await this.db.read(rootEntity, scopeId);
    const filterOpts = { filters: [{ field: scopeField, op: 'eq', value: scopeId }] };

    const children: Record<string, Record<string, unknown>[]> = {};
    for (const entity of childEntities) {
      children[entity] = (await this.db.list(entity, filterOpts)) as Record<string, unknown>[];
    }

    return {
      root: root as Record<string, unknown>,
      children,
    };
  }

  async loadScope(scopeId: string): Promise<ScopeBundle | null> {
    return this.serialized('loadScope', async () => {
      try {
        return await this.loadScopeInner(scopeId);
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return await this.loadScopeInner(scopeId);
          } catch {
            return null;
          }
        }
        return null;
      }
    });
  }

  async listRootEntities(sort?: SortField[]): Promise<Record<string, unknown>[]> {
    return this.serialized('listRootEntities', async () => {
      if (!this.db || !this.initialSyncDone) return [];
      const { rootEntity } = this.config.scope;
      const options: Record<string, unknown> = {};
      if (sort && sort.length > 0) {
        options.sort = sort;
      }
      try {
        return (await this.db.list(rootEntity, options)) as Record<string, unknown>[];
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return (await this.db!.list(rootEntity, options)) as Record<string, unknown>[];
          } catch {
            return [];
          }
        }
        throw err;
      }
    });
  }

  private async syncRootEntityList(): Promise<void> {
    await this.serialized('syncRootEntityList', async () => {
      if (!this.db || !this.sync) return;

      const { rootEntity, childEntities } = this.config.scope;
      const userScopeField = this.config.userScopeField;

      this.initialSyncDone = false;
      this.notifyEntitySubscribers(rootEntity, null, 'update');

      const allEntities = await this.sync.fetchList(rootEntity);
      if (allEntities === null) {
        this.initialSyncDone = true;
        this.notifyEntitySubscribers(rootEntity, null, 'update');
        return;
      }

      const currentUser = this.authenticatedUser;
      const serverEntities =
        currentUser && userScopeField
          ? allEntities.filter((d) => d[userScopeField] === currentUser)
          : allEntities;

      const localEntities = (await this.db.list(rootEntity, {})) as Array<Record<string, unknown>>;
      for (const local of localEntities) {
        const id = local.id as string;
        if (!id) continue;
        if (!currentUser) continue;

        const inServer = serverEntities.some((d) => (d.id as string) === id);
        if (inServer) continue;

        const pending = currentUser
          ? ((await this.db.list('pending_sync', {
              filters: [
                { field: 'scopeId', op: 'eq', value: id },
                { field: 'userId', op: 'eq', value: currentUser },
              ],
            })) as Array<Record<string, unknown>>)
          : [];

        const hasPendingInsert = pending.some(
          (p) => (p.op as string) === 'insert' && (p.entity as string) === rootEntity
        );
        if (hasPendingInsert) continue;

        await this.db.delete(rootEntity, id);
        for (const p of pending) {
          await this.db.delete('pending_sync', p.id as string);
        }
      }

      const versionField = this.config.versionField ?? 'version';

      for (const entity of serverEntities) {
        const id = entity.id as string;
        if (!id) continue;

        const pendingForEntity = currentUser
          ? ((await this.db.list('pending_sync', {
              filters: [
                { field: 'scopeId', op: 'eq', value: id },
                { field: 'userId', op: 'eq', value: currentUser },
              ],
            })) as Array<Record<string, unknown>>)
          : [];

        const hasPendingDelete = pendingForEntity.some(
          (p) => (p.op as string) === 'delete' && (p.entity as string) === rootEntity
        );
        if (hasPendingDelete) continue;

        if (entity[versionField] != null && typeof entity[versionField] !== 'number') {
          entity[versionField] = Number(entity[versionField]) || 1;
        }

        try {
          await this.db.read(rootEntity, id);
          await this.db.update(rootEntity, id, entity);
        } catch {
          await this.db.create(rootEntity, entity);
        }

        const childResults = await Promise.all(
          childEntities.map((childEntity) => this.sync!.fetchList(childEntity, id))
        );

        for (let i = 0; i < childEntities.length; i++) {
          const records = childResults[i];
          if (records === null) continue;
          await this.reconcileChildren(id, childEntities[i], records);
        }
      }

      if (this.config.topLevelEntities) {
        for (const topLevel of this.config.topLevelEntities) {
          await this.reconcileTopLevelEntity(topLevel.entity);
        }
      }

      this.initialSyncDone = true;
      this.notifyEntitySubscribers(rootEntity, null, 'update');
    });
  }

  private async reconcileChildren(
    scopeId: string,
    entity: string,
    serverRecords: Array<Record<string, unknown>>
  ): Promise<void> {
    if (!this.db) return;

    const { scopeField } = this.config.scope;

    const localRecords = (await this.db.list(entity, {
      filters: [{ field: scopeField, op: 'eq', value: scopeId }],
    })) as Array<Record<string, unknown>>;

    const pendingFilters: Array<Record<string, unknown>> = [
      { field: 'scopeId', op: 'eq', value: scopeId },
      { field: 'entity', op: 'eq', value: entity },
    ];
    if (this.authenticatedUser) {
      pendingFilters.push({ field: 'userId', op: 'eq', value: this.authenticatedUser });
    }
    const pendingRecords = (await this.db.list('pending_sync', {
      filters: pendingFilters,
    })) as Array<Record<string, unknown>>;

    const serverMap = new Map(serverRecords.map((r) => [r.id as string, r]));
    const localMap = new Map(localRecords.map((r) => [r.id as string, r]));

    const pendingByEntityId = new Map<string, Array<Record<string, unknown>>>();
    for (const p of pendingRecords) {
      const eid = p.entityId as string;
      const arr = pendingByEntityId.get(eid) ?? [];
      arr.push(p);
      pendingByEntityId.set(eid, arr);
    }

    const hasPendingDelete = new Set<string>();
    for (const p of pendingRecords) {
      if (p.op === 'delete') hasPendingDelete.add(p.entityId as string);
    }

    for (const record of serverRecords) {
      const id = record.id as string;
      if (!id) continue;
      if (hasPendingDelete.has(id)) continue;
      const pendingOps = pendingByEntityId.get(id);
      if (pendingOps && pendingOps.some((p) => p.op === 'update')) continue;
      const cleaned = stripNulls(record);
      if (!cleaned[scopeField]) {
        cleaned[scopeField] = scopeId;
      }
      if (localMap.has(id)) {
        await this.db.update(entity, id, cleaned);
      } else {
        await this.db.create(entity, cleaned);
      }
    }

    for (const p of pendingRecords) {
      const eid = p.entityId as string;
      const op = p.op as string;
      if (op === 'delete') continue;
      if (serverMap.has(eid)) continue;
      if (localMap.has(eid)) continue;
      if (p.data) {
        try {
          await this.db.create(entity, p.data as Record<string, unknown>);
        } catch {
          // already exists from a race
        }
      }
    }

    for (const [id] of localMap) {
      if (serverMap.has(id)) continue;
      if (pendingByEntityId.has(id)) continue;
      try {
        await this.db.delete(entity, id);
      } catch {
        // already gone
      }
    }

    for (const p of pendingRecords) {
      const eid = p.entityId as string;
      const op = p.op as string;
      const confirmed =
        (op === 'insert' && serverMap.has(eid)) || (op === 'delete' && !serverMap.has(eid));
      if (confirmed) {
        try {
          await this.db.delete('pending_sync', p.id as string);
        } catch {
          // already cleaned up
        }
      }
    }
  }

  private async reconcileTopLevelEntity(entity: string): Promise<void> {
    if (!this.db || !this.sync) return;

    const serverRecords = await this.sync.fetchList(entity);
    if (serverRecords === null) return;

    const serverMap = new Map<string, Record<string, unknown>>();
    for (const r of serverRecords) {
      serverMap.set(r.id as string, r);
    }

    const localRecords = (await this.db.list(entity, {})) as Array<Record<string, unknown>>;
    for (const local of localRecords) {
      const id = local.id as string;
      if (serverMap.has(id)) continue;

      const pendingInserts = (await this.db.list('pending_sync', {
        filters: [
          { field: 'entity', op: 'eq', value: entity },
          { field: 'entityId', op: 'eq', value: id },
          { field: 'op', op: 'eq', value: 'insert' },
        ],
      })) as Array<Record<string, unknown>>;
      if (pendingInserts.length > 0) continue;

      await this.db.delete(entity, id);
    }

    for (const serverRecord of serverRecords) {
      const id = serverRecord.id as string;
      try {
        await this.db.read(entity, id);
        await this.db.update(entity, id, serverRecord);
      } catch {
        await this.db.create(entity, serverRecord);
      }
    }
  }

  async getChildCount(entity: string, scopeId: string): Promise<number> {
    return this.serialized('getChildCount', async () => {
      if (!this.db) return 0;
      const { scopeField } = this.config.scope;
      const filterOpts = { filters: [{ field: scopeField, op: 'eq', value: scopeId }] };
      try {
        return await this.db.count(entity, filterOpts);
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return await this.db!.count(entity, filterOpts);
          } catch {
            return 0;
          }
        }
        return 0;
      }
    });
  }

  private async setupSchemas(): Promise<void> {
    if (!this.db) return;

    const { entities, localOnlyEntities } = this.config;
    for (const [entity, definition] of Object.entries(entities)) {
      await this.db.addSchemaAsync(entity, definition);
      if (definition.foreignKeys) {
        for (const fk of definition.foreignKeys) {
          await this.db.addForeignKeyAsync(entity, fk.field, fk.references, 'id', fk.onDelete);
        }
      }
      if (definition.indexes) {
        for (const field of definition.indexes) {
          await this.db.addIndexAsync(entity, [field]);
        }
      }
    }

    if (localOnlyEntities) {
      for (const [entity, definition] of Object.entries(localOnlyEntities)) {
        await this.db.addSchemaAsync(entity, definition);
        if (definition.indexes) {
          for (const field of definition.indexes) {
            await this.db.addIndexAsync(entity, [field]);
          }
        }
      }
    }

    const pendingSyncDef = this.config.localOnlyEntities?.['pending_sync'];
    if (!pendingSyncDef) {
      await this.db.addSchemaAsync('pending_sync', {
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'op', type: 'string', required: true },
          { name: 'entity', type: 'string', required: true },
          { name: 'entityId', type: 'string', required: true },
          { name: 'scopeId', type: 'string', required: true },
          { name: 'userId', type: 'string', required: true },
          { name: 'data', type: 'object' },
          { name: 'createdAt', type: 'number' },
        ],
        indexes: ['scopeId', 'entity'],
      });
    }
  }

  private unsubscribeAllWasm(): void {
    if (this.db) {
      for (const subId of this.wasmSubscriptionIds.values()) {
        try {
          this.db.unsubscribe(subId);
        } catch {
          // DB may already be in a broken state
        }
      }
    }
    this.wasmSubscriptionIds.clear();
  }

  private setupWasmSubscriptions(): void {
    if (!this.db) return;
    this.unsubscribeAllWasm();

    const allEntities = [...this.allSyncedEntities, ...this.allLocalEntities];

    for (const entity of allEntities) {
      const subId = this.db.subscribe('#', entity, (event: unknown) => {
        if (this.suppressEntityNotifications) return;
        const evt = event as { operation?: string; data?: unknown };
        const op = this.parseOperationFromEvent(evt.operation);
        if (op) {
          this.notifyEntitySubscribers(entity, evt.data, op);
        }
      });
      this.wasmSubscriptionIds.set(entity, subId);
    }
  }

  private isDbCorrupted(err: unknown): boolean {
    if (err instanceof Error && err.name === 'RuntimeError') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /transaction.*null|arg0 is null|transaction error|index out of bounds|database is busy|unreachable/i.test(
      msg
    );
  }

  private async recoverDb(): Promise<boolean> {
    if (this.dbRecovering) return false;
    this.dbRecovering = true;
    const oldDb = this.db;
    try {
      const wasmMod = await import('mqdb-wasm');
      this.db = await wasmMod.Database.openPersistent(this.config.dbName);
      await this.setupSchemas();
      this.setupWasmSubscriptions();
      return true;
    } catch {
      this.db = oldDb;
      return false;
    } finally {
      this.dbRecovering = false;
    }
  }

  private parseOperationFromEvent(
    operation: string | undefined
  ): 'insert' | 'update' | 'delete' | null {
    if (!operation) return null;
    if (operation === 'create') return 'insert';
    if (operation === 'update') return 'update';
    if (operation === 'delete') return 'delete';
    return null;
  }

  private getOrCreateClientId(): string {
    const key = 'stitch_client_id';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  subscribeToConnectionStatus(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    callback(this.connectionStatus);
    return () => this.statusListeners.delete(callback);
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  private async applyMutationToDb(mutation: SyncMutation): Promise<void> {
    if (!this.db) return;

    const { scopeField, rootEntity } = this.config.scope;

    try {
      switch (mutation.op) {
        case 'insert':
          if (mutation.data) {
            const refScopeId = mutation.data[scopeField] as string | undefined;
            if (refScopeId) {
              try {
                await this.db.read(rootEntity, refScopeId);
              } catch (readErr) {
                const msg = readErr instanceof Error ? readErr.message : String(readErr);
                if (/not found/i.test(msg)) return;
                throw readErr;
              }
            }
            await this.db.create(mutation.entity, { ...mutation.data, id: mutation.id });
          }
          break;
        case 'update':
          if (mutation.data) {
            try {
              const existing = (await this.db.read(mutation.entity, mutation.id)) as Record<
                string,
                unknown
              >;
              const remoteVersion = mutation.data._version;
              if (typeof remoteVersion === 'number') {
                const localVersion = typeof existing._version === 'number' ? existing._version : 0;
                if (remoteVersion < localVersion) return;
              }
              const updatedAtField = this.config.updatedAtField ?? 'updatedAt';
              const remoteUpdatedAt = mutation.data[updatedAtField];
              const localUpdatedAt = existing[updatedAtField];
              if (
                typeof remoteUpdatedAt === 'number' &&
                typeof localUpdatedAt === 'number' &&
                remoteUpdatedAt < localUpdatedAt
              ) {
                return;
              }
            } catch (readErr) {
              const msg = readErr instanceof Error ? readErr.message : String(readErr);
              if (/not found/i.test(msg)) return;
              throw readErr;
            }
            await this.db.update(mutation.entity, mutation.id, mutation.data);
          }
          break;
        case 'delete':
          try {
            await this.db.delete(mutation.entity, mutation.id);
          } catch (delErr) {
            const msg = delErr instanceof Error ? delErr.message : String(delErr);
            if (!/not found/i.test(msg)) throw delErr;
          }
          break;
      }
    } catch (err) {
      console.error('[PersistenceStore] Failed to apply remote mutation:', err);
    }
  }

  private async handleRemoteMutation(mutation: SyncMutation): Promise<void> {
    await this.serialized('handleRemoteMutation', () => this.applyMutationToDb(mutation));
  }

  private notifyEntitySubscribers(
    entity: string,
    data: unknown,
    op: 'insert' | 'update' | 'delete'
  ): void {
    const subscribers = this.entitySubscriptions.get(entity);
    if (subscribers) {
      for (const callback of subscribers) {
        callback(data, op);
      }
    }
  }

  subscribe(entity: string, callback: EntitySubscriptionCallback): () => void {
    if (!this.entitySubscriptions.has(entity)) {
      this.entitySubscriptions.set(entity, new Set());
    }
    this.entitySubscriptions.get(entity)!.add(callback);

    return () => {
      this.entitySubscriptions.get(entity)?.delete(callback);
    };
  }

  async list(entity: string, filter?: ListFilter): Promise<Record<string, unknown>[]> {
    return this.serialized('list:' + entity, async () => {
      if (!this.db) return [];

      const { scopeField } = this.config.scope;
      const options: Record<string, unknown> = {};
      if (filter?.scopeId) {
        options.filters = [{ field: scopeField, op: 'eq', value: filter.scopeId }];
      }
      if (filter?.sort && filter.sort.length > 0) {
        options.sort = filter.sort;
      }
      if (filter?.projection && filter.projection.length > 0) {
        options.projection = filter.projection;
      }

      try {
        return (await this.db.list(entity, options)) as Record<string, unknown>[];
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return (await this.db!.list(entity, options)) as Record<string, unknown>[];
          } catch {
            return [];
          }
        }
        throw err;
      }
    });
  }

  async openScope(scopeId: string): Promise<void> {
    await this.serialized('openScope', async () => {
      const { rootEntity, childEntities } = this.config.scope;
      const versionField = this.config.versionField ?? 'version';

      this.currentScopeId = scopeId;

      if (this.connectionStatus === 'connected' && this.sync && this.db) {
        this.suppressEntityNotifications = true;
        try {
          const state = await this.sync.openScope(scopeId);

          if (state.root && state.root.id) {
            if (state.root[versionField] != null && typeof state.root[versionField] !== 'number') {
              state.root[versionField] = Number(state.root[versionField]) || 1;
            }
            try {
              await this.db.read(rootEntity, state.root.id as string);
              await this.db.update(rootEntity, state.root.id as string, state.root);
            } catch {
              await this.db.create(rootEntity, state.root);
            }
          } else {
            try {
              await this.db.read(rootEntity, scopeId);
            } catch {
              return;
            }
          }

          for (const childEntity of childEntities) {
            const serverChildren = state.children[childEntity] ?? [];
            await this.reconcileChildren(scopeId, childEntity, serverChildren);
          }

          for (const mutation of state.bufferedMutations) {
            await this.applyMutationToDb(mutation);
          }
        } catch (err) {
          console.error('[PersistenceStore] Failed to open scope from server:', err);
        } finally {
          this.suppressEntityNotifications = false;
        }
      }
    });
  }

  async closeScope(scopeId: string): Promise<void> {
    if (this.connectionStatus === 'connected' && this.sync) {
      await this.sync.closeScope(scopeId);
    }
    if (this.currentScopeId === scopeId) {
      this.currentScopeId = null;
    }
  }

  private async syncCreate(
    entity: string,
    scopeId: string,
    record: Record<string, unknown>
  ): Promise<void> {
    if (!this.sync) throw new Error('Not connected');
    const { rootEntity, childEntities } = this.config.scope;
    const isChild = childEntities.includes(entity);
    const isTopLevel = this.config.topLevelEntities?.some((t) => t.entity === entity);

    if (entity === rootEntity || isTopLevel) {
      await this.sync.createEntity(entity, null, record);
    } else if (isChild) {
      await this.sync.createEntity(entity, scopeId, record);
    }
  }

  private async syncUpdate(
    entity: string,
    scopeId: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void> {
    if (!this.sync) throw new Error('Not connected');
    const { rootEntity, childEntities } = this.config.scope;
    const isChild = childEntities.includes(entity);

    if (entity === rootEntity) {
      await this.sync.updateEntity(entity, null, id, data);
    } else if (isChild) {
      await this.sync.updateEntity(entity, scopeId, id, data);
    } else {
      await this.sync.updateEntity(entity, null, id, data);
    }
  }

  private async syncDelete(entity: string, scopeId: string, id: string): Promise<void> {
    if (!this.sync) throw new Error('Not connected');
    const { rootEntity, childEntities } = this.config.scope;
    const isChild = childEntities.includes(entity);

    if (entity === rootEntity) {
      await this.sync.deleteEntity(entity, null, id);
    } else if (isChild) {
      await this.sync.deleteEntity(entity, scopeId, id);
    } else {
      await this.sync.deleteEntity(entity, null, id);
    }
  }

  async create(entity: string, data: Record<string, unknown>): Promise<string> {
    return this.serialized('create:' + entity, async () => {
      if (!this.db) throw new Error('Database not initialized');

      const { rootEntity, scopeField } = this.config.scope;
      const id = (data.id as string) || crypto.randomUUID();
      const record = stripNulls({ ...data, id });
      const scopeId = entity === rootEntity ? id : (data[scopeField] as string);

      try {
        await this.db.create(entity, record);
      } catch (createErr) {
        if (this.isDbCorrupted(createErr) && (await this.recoverDb())) {
          await this.db!.create(entity, record);
        } else {
          throw createErr;
        }
      }

      if (scopeId) {
        await this.queueMutation({ op: 'insert', entity, id, scopeId, data: record });
      }

      if (this.connectionStatus === 'connected' && this.sync && scopeId) {
        try {
          await this.syncCreate(entity, scopeId, record);
          await this.removePendingMutation(entity, id, scopeId, 'insert');
        } catch (err) {
          if (err instanceof OwnershipError) {
            await this.removePendingMutation(entity, id, scopeId, 'insert');
            throw err;
          }
          if (!isTransientSyncError(err)) {
            console.error(`[PersistenceStore] Failed to sync create ${entity}:`, err);
          }
        }
      }

      return id;
    });
  }

  async update(entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.serialized('update:' + entity, async () => {
      if (!this.db) throw new Error('Database not initialized');

      const { rootEntity, scopeField } = this.config.scope;

      let existing: Record<string, unknown>;
      try {
        existing = await this.db.read(entity, id);
      } catch (readErr) {
        if (this.isDbCorrupted(readErr) && (await this.recoverDb())) {
          try {
            existing = await this.db!.read(entity, id);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            if (/not found/i.test(msg)) return;
            throw retryErr;
          }
        } else {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          if (/not found/i.test(msg)) return;
          throw readErr;
        }
      }

      const scopeId = entity === rootEntity ? id : (existing[scopeField] as string | undefined);

      try {
        await this.db.update(entity, id, data);
      } catch (updErr) {
        if (this.isDbCorrupted(updErr) && (await this.recoverDb())) {
          await this.db!.update(entity, id, data);
        } else {
          throw updErr;
        }
      }

      if (scopeId) {
        await this.queueMutation({ op: 'update', entity, id, scopeId, data });
      }

      if (this.connectionStatus === 'connected' && this.sync && scopeId) {
        try {
          await this.syncUpdate(entity, scopeId, id, data);
          await this.removePendingMutation(entity, id, scopeId, 'update');
        } catch (err) {
          if (err instanceof OwnershipError) {
            await this.removePendingMutation(entity, id, scopeId, 'update');
            throw err;
          }
          const isNotFound = err instanceof Error && /not found/i.test(err.message);
          if (isNotFound && entity === rootEntity) {
            try {
              await this.db!.delete(rootEntity, id);
            } catch {
              // already gone locally
            }
            await this.removePendingMutation(entity, id, scopeId, 'update');
          } else if (isNotFound) {
            try {
              const full = await this.db!.read(entity, id);
              await this.syncCreate(entity, scopeId, full);
            } catch (createErr) {
              if (createErr instanceof OwnershipError) {
                await this.removePendingMutation(entity, id, scopeId, 'update');
                throw createErr;
              }
              if (!isTransientSyncError(createErr)) {
                console.error(`[PersistenceStore] Failed to sync upsert ${entity}:`, createErr);
              }
            }
          } else if (!isTransientSyncError(err)) {
            console.error(`[PersistenceStore] Failed to sync update ${entity}:`, err);
          }
        }
      }
    });
  }

  async delete(entity: string, id: string): Promise<void> {
    await this.serialized('delete:' + entity, async () => {
      if (!this.db) throw new Error('Database not initialized');

      const { rootEntity, scopeField } = this.config.scope;

      let existing: Record<string, unknown>;
      try {
        existing = await this.db.read(entity, id);
      } catch (readErr) {
        if (this.isDbCorrupted(readErr) && (await this.recoverDb())) {
          try {
            existing = await this.db!.read(entity, id);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            if (/not found/i.test(msg)) return;
            throw retryErr;
          }
        } else {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          if (/not found/i.test(msg)) return;
          throw readErr;
        }
      }

      const scopeId = entity === rootEntity ? id : (existing[scopeField] as string | undefined);

      try {
        await this.db.delete(entity, id);
      } catch (delErr) {
        const delMsg = delErr instanceof Error ? delErr.message : String(delErr);
        if (/not found/i.test(delMsg)) return;
        if (this.isDbCorrupted(delErr) && (await this.recoverDb())) {
          await this.db!.delete(entity, id);
        } else {
          throw delErr;
        }
      }

      if (scopeId) {
        await this.queueMutation({ op: 'delete', entity, id, scopeId, data: null });
      }

      if (this.connectionStatus === 'connected' && this.sync && scopeId) {
        try {
          await this.syncDelete(entity, scopeId, id);
          await this.removePendingMutation(entity, id, scopeId, 'delete');
        } catch (err) {
          if (err instanceof OwnershipError) {
            await this.removePendingMutation(entity, id, scopeId, 'delete');
            throw err;
          }
          const isNotFound = err instanceof Error && /not found/i.test(err.message);
          if (!isNotFound) {
            if (!isTransientSyncError(err)) {
              console.error(`[PersistenceStore] Failed to sync delete ${entity}:`, err);
            }
          }
        }
      }
    });
  }

  private async queueMutation(mutation: PendingMutation): Promise<void> {
    if (!this.db || !this.authenticatedUser) return;

    try {
      const record: Record<string, unknown> = {
        id: crypto.randomUUID(),
        op: mutation.op,
        entity: mutation.entity,
        entityId: mutation.id,
        scopeId: mutation.scopeId,
        userId: this.authenticatedUser,
        createdAt: Date.now(),
      };
      if (mutation.data !== null) {
        record.data = mutation.data;
      }
      await this.db.create('pending_sync', record);
    } catch (err) {
      console.error('[PersistenceStore] Failed to persist pending mutation:', err);
    }
  }

  private async removePendingMutation(
    entity: string,
    entityId: string,
    scopeId: string,
    mutationOp: PendingMutation['op']
  ): Promise<void> {
    if (!this.db) return;

    try {
      const filters: Array<Record<string, unknown>> = [
        { field: 'entity', op: 'eq', value: entity },
        { field: 'entityId', op: 'eq', value: entityId },
        { field: 'scopeId', op: 'eq', value: scopeId },
        { field: 'op', op: 'eq', value: mutationOp },
      ];
      if (this.authenticatedUser) {
        filters.push({ field: 'userId', op: 'eq', value: this.authenticatedUser });
      }
      const records = (await this.db.list('pending_sync', {
        filters,
      })) as Array<Record<string, unknown>>;

      for (const record of records) {
        await this.db.delete('pending_sync', record.id as string);
      }
    } catch (err) {
      console.error('[PersistenceStore] Failed to remove pending mutation:', err);
    }
  }

  private async flushPendingMutations(): Promise<void> {
    await this.serialized('flushPendingMutations', async () => {
      if (this.connectionStatus !== 'connected' || !this.sync || !this.db || this.isFlushing)
        return;

      this.isFlushing = true;
      try {
        await this.flushPendingMutationsInner();
      } finally {
        this.isFlushing = false;
      }
    });
  }

  private consolidatePendingMutations(records: Array<Record<string, unknown>>): Array<{
    op: PendingMutation['op'];
    entity: string;
    id: string;
    scopeId: string;
    data: Record<string, unknown> | null;
    recordIds: string[];
  }> {
    const grouped = new Map<
      string,
      Array<{
        recordId: string;
        op: PendingMutation['op'];
        data: Record<string, unknown> | null;
        entity: string;
        entityId: string;
        scopeId: string;
        createdAt: number;
      }>
    >();

    for (const r of records) {
      const key = `${r.entity as string}:${r.entityId as string}`;
      const entry = {
        recordId: r.id as string,
        op: r.op as PendingMutation['op'],
        data: (r.data as Record<string, unknown>) || null,
        entity: r.entity as string,
        entityId: r.entityId as string,
        scopeId: r.scopeId as string,
        createdAt: (r.createdAt as number) || 0,
      };
      const arr = grouped.get(key);
      if (arr) {
        arr.push(entry);
      } else {
        grouped.set(key, [entry]);
      }
    }

    const result: Array<{
      op: PendingMutation['op'];
      entity: string;
      id: string;
      scopeId: string;
      data: Record<string, unknown> | null;
      recordIds: string[];
    }> = [];

    for (const [, entries] of grouped) {
      entries.sort((a, b) => a.createdAt - b.createdAt);

      const recordIds = entries.map((e) => e.recordId);
      const hasInsert = entries.some((e) => e.op === 'insert');
      const hasDelete = entries.some((e) => e.op === 'delete');
      const { entity, entityId, scopeId } = entries[0];

      if (hasInsert && hasDelete) {
        result.push({
          op: 'delete' as const,
          entity,
          id: entityId,
          scopeId,
          data: null,
          recordIds,
        });
        continue;
      }

      if (hasInsert) {
        const insertEntry = entries.find((e) => e.op === 'insert')!;
        const mergedData = insertEntry.data ? { ...insertEntry.data } : {};
        for (const e of entries) {
          if (e !== insertEntry && e.data) {
            Object.assign(mergedData, e.data);
          }
        }
        result.push({
          op: 'insert',
          entity,
          id: entityId,
          scopeId,
          data: mergedData,
          recordIds,
        });
        continue;
      }

      if (hasDelete) {
        result.push({ op: 'delete', entity, id: entityId, scopeId, data: null, recordIds });
        continue;
      }

      const mergedData: Record<string, unknown> = {};
      for (const e of entries) {
        if (e.data) Object.assign(mergedData, e.data);
      }
      result.push({
        op: 'update',
        entity,
        id: entityId,
        scopeId,
        data: Object.keys(mergedData).length > 0 ? mergedData : null,
        recordIds,
      });
    }

    const opPriority: Record<string, number> = { insert: 0, update: 1, delete: 2 };
    result.sort((a, b) => {
      const aTime = Math.min(
        ...records
          .filter((r) => a.recordIds.includes(r.id as string))
          .map((r) => (r.createdAt as number) || 0)
      );
      const bTime = Math.min(
        ...records
          .filter((r) => b.recordIds.includes(r.id as string))
          .map((r) => (r.createdAt as number) || 0)
      );
      if (aTime !== bTime) return aTime - bTime;
      return (opPriority[a.op] ?? 1) - (opPriority[b.op] ?? 1);
    });

    return result;
  }

  private async removePendingRecords(ids: string[]): Promise<void> {
    if (!this.db) return;
    for (const id of ids) {
      try {
        await this.db.delete('pending_sync', id);
      } catch {
        // already cleaned up
      }
    }
  }

  private async flushPendingMutationsInner(): Promise<void> {
    if (!this.db || !this.sync || !this.authenticatedUser) return;

    const pendingRecords = (await this.db.list('pending_sync', {
      filters: [{ field: 'userId', op: 'eq', value: this.authenticatedUser }],
    })) as Array<Record<string, unknown>>;

    if (pendingRecords.length === 0) return;

    const consolidated = this.consolidatePendingMutations(pendingRecords);

    for (const mutation of consolidated) {
      const { op, entity, id, scopeId, data, recordIds } = mutation;

      try {
        switch (op) {
          case 'insert':
            if (data) {
              await this.syncCreate(entity, scopeId, data);
            }
            break;
          case 'update':
            if (data) {
              await this.syncUpdate(entity, scopeId, id, data);
            }
            break;
          case 'delete':
            await this.syncDelete(entity, scopeId, id);
            break;
        }
        await this.removePendingRecords(recordIds);
      } catch (err) {
        const { rootEntity } = this.config.scope;
        const isNotFound = err instanceof Error && /not found/i.test(err.message);
        const isConflict =
          err instanceof Error && /already exists|conflict|duplicate/i.test(err.message);

        if (isNotFound && op === 'update' && entity === rootEntity) {
          try {
            await this.db!.delete(rootEntity, id);
          } catch {
            // already gone
          }
          await this.removePendingRecords(recordIds);
        } else if (isNotFound && op === 'update') {
          try {
            const full = await this.db!.read(entity, id);
            await this.syncCreate(entity, scopeId, full);
            await this.removePendingRecords(recordIds);
          } catch (upsertErr) {
            if (!isTransientSyncError(upsertErr)) {
              console.error(
                `[PersistenceStore] Failed to upsert ${entity} during flush:`,
                upsertErr
              );
              await this.removePendingRecords(recordIds);
            }
          }
        } else if (isNotFound && op === 'delete') {
          await this.removePendingRecords(recordIds);
        } else if (isConflict && op === 'insert') {
          if (data) {
            try {
              await this.syncUpdate(entity, scopeId, id, data);
              await this.removePendingRecords(recordIds);
            } catch (updateErr) {
              if (updateErr instanceof OwnershipError) {
                await this.removePendingRecords(recordIds);
              } else if (!isTransientSyncError(updateErr)) {
                console.error(
                  `[PersistenceStore] Failed to update-on-conflict ${entity} during flush:`,
                  updateErr
                );
              }
            }
          } else {
            await this.removePendingRecords(recordIds);
          }
        } else if (err instanceof OwnershipError) {
          await this.removePendingRecords(recordIds);
        } else if (isTransientSyncError(err)) {
          // leave for next flush cycle
        } else {
          console.error('[PersistenceStore] Failed to flush mutation:', err);
        }
      }
    }
  }

  async readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null> {
    return this.serialized('readLocalState', async () => {
      if (!this.db) return null;
      try {
        return (await this.db.read(entity, id)) as Record<string, unknown>;
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return (await this.db!.read(entity, id)) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
        return null;
      }
    });
  }

  async updateLocalState(
    entity: string,
    id: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await this.serialized(
      'updateLocalState',
      async () => {
        if (!this.db) return;
        try {
          await this.db.update(entity, id, fields);
        } catch {
          try {
            await this.db.create(entity, { id, ...fields });
          } catch {
            // best effort
          }
        }
      },
      5000
    );
  }

  async getCachedUser(): Promise<Record<string, unknown> | null> {
    try {
      const raw = sessionStorage.getItem('stitch_cached_user');
      if (!raw) return null;
      const envelope: unknown = JSON.parse(raw);
      if (typeof envelope !== 'object' || envelope === null) return null;
      const { user, cachedAt } = envelope as Record<string, unknown>;
      const MAX_AGE_MS = 15 * 60 * 1000;
      if (typeof cachedAt !== 'number' || Date.now() - cachedAt > MAX_AGE_MS) {
        sessionStorage.removeItem('stitch_cached_user');
        return null;
      }
      if (typeof user !== 'object' || user === null) return null;
      return user as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async setCachedUser(user: Record<string, unknown>): Promise<void> {
    sessionStorage.setItem('stitch_cached_user', JSON.stringify({ user, cachedAt: Date.now() }));
    sessionStorage.removeItem('stitch_pending_logout');
  }

  async clearCachedUser(): Promise<void> {
    sessionStorage.removeItem('stitch_cached_user');
  }

  resetForLogout(): void {
    this.shuttingDown = true;
    this._opQueue = Promise.resolve();
    this.unsubscribeAllWasm();
    this.entitySubscriptions.clear();
    this.currentScopeId = null;
    this.db = null;
    this.sync = null;
    this.initialized = false;
    this.initializing = false;
    this.initialSyncDone = false;
    this.authenticatedUser = null;
    this.sessionInvalidHandler = null;
    this.reconnectValidator = null;
    this.setConnectionStatus('offline');
    this.shuttingDown = false;
    sessionStorage.removeItem('stitch_client_id');
    sessionStorage.removeItem('stitch_cached_user');
    sessionStorage.removeItem('stitch_pending_logout');
  }

  async hasPendingLogout(): Promise<boolean> {
    return sessionStorage.getItem('stitch_pending_logout') === 'true';
  }

  async setPendingLogout(pending: boolean): Promise<void> {
    if (pending) {
      sessionStorage.setItem('stitch_pending_logout', 'true');
    } else {
      sessionStorage.removeItem('stitch_pending_logout');
    }
  }

  async flushPendingLogout(logoutFn: () => Promise<void>): Promise<void> {
    const pending = await this.hasPendingLogout();
    if (!pending) return;
    try {
      await logoutFn();
      await this.setPendingLogout(false);
    } catch {
      // best-effort
    }
  }

  setSessionInvalidHandler(handler: () => void): void {
    this.sessionInvalidHandler = handler;
  }

  setReconnectValidator(validator: () => Promise<void>): void {
    this.reconnectValidator = validator;
  }

  private revalidateSessionOnReconnect(): void {
    this.reconnectValidator?.().catch(() => {});
  }

  private handleSessionInvalid(): void {
    this.clearCachedUser().catch(() => {});
    this.disconnect();
    this.sessionInvalidHandler?.();
  }
}

export function createPersistenceStore(config: StoreConfig): PersistenceStore {
  return new PersistenceStoreImpl(config);
}
