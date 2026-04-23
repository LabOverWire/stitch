import type {
  StoreConfig,
  StoreOptions,
  Store,
  MemoryStore,
  PersistenceLayer,
  RemoteSyncLayer,
  OfflineQueue,
  LocalAccessor,
  MutationSender,
  MutationEvent,
  ConnectionStatus,
  SortField,
  ListFilter,
  SyncMutation,
} from './types.ts';
import { OwnershipError } from './types.ts';
import { createMemoryStore } from './memory-store.ts';
import { createPersistenceLayer } from './persistence-layer.ts';
import { createRemoteSyncLayer } from './remote-sync-layer.ts';
import { createPersistentOfflineQueue, createInMemoryOfflineQueue } from './offline-queue.ts';
import { stripNulls, isTransientSyncError } from './internal-utils.ts';

type PersistenceLayerExt = PersistenceLayer & {
  notifyCorruption(): void;
  setSuppressNotifications(suppress: boolean): void;
  notifyAllEntitySubscribers(): void;
};

type RemoteSyncLayerExt = RemoteSyncLayer & {
  setMutationCallback(cb: (mutation: SyncMutation) => void): void;
  setConnectionChangeCallback(cb: (status: ConnectionStatus) => void): void;
  setOnConnectedCallback(cb: () => void): void;
  readonly isInitialSyncDone: boolean;
};

type OfflineQueueExt = OfflineQueue & {
  setAuthenticatedUser?(userId: string | null): void;
};

class StoreImpl implements Store {
  readonly config: StoreConfig;
  readonly memory: MemoryStore;
  private _persistence: PersistenceLayerExt | null = null;
  private _remote: RemoteSyncLayerExt | null = null;
  private _queue: OfflineQueueExt | null = null;
  private readonly options: StoreOptions;
  private _ready = false;
  private _initPromise: Promise<void> | null = null;
  private _connectionStatus: ConnectionStatus = 'offline';
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private currentScopeId: string | null = null;
  private initialSyncDone = false;
  private _authenticatedUser: string | null = null;
  private _earlySubscribers: Array<{
    entity: string;
    callback: (data: unknown, op: 'insert' | 'update' | 'delete') => void;
    memoryUnsub: () => void;
  }> = [];

  constructor(config: StoreConfig, options: StoreOptions) {
    this.config = config;
    this.options = options;
    this.memory = createMemoryStore(config);
  }

  get ready(): boolean {
    return this._ready;
  }

  get connectionStatus(): ConnectionStatus {
    if (this._remote) return this._remote.connectionStatus;
    return this._connectionStatus;
  }

  get isReconnecting(): boolean {
    return this._remote?.isReconnecting ?? false;
  }

  get hasPersistence(): boolean {
    return this._persistence !== null;
  }

  get hasRemote(): boolean {
    return this._remote !== null;
  }

  async initialize(): Promise<void> {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this.doInitialize().finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (this._ready) return;

    await this.memory.ensureReady();

    if (this.options.persistence) {
      const persistence = createPersistenceLayer(this.config);
      this._persistence = persistence;
      await persistence.open(this.options.persistence.dbName);

      this.memory.onCorruption(() => {
        persistence.notifyCorruption();
      });

      for (const entry of this._earlySubscribers) {
        entry.memoryUnsub();
        persistence.subscribe(entry.entity, entry.callback);
      }
      this._earlySubscribers = [];
    }

    if (this.options.remote) {
      const remote = createRemoteSyncLayer(this.config);
      this._remote = remote;

      if (this._authenticatedUser) {
        remote.setAuthenticatedUser(this._authenticatedUser);
      }

      if (this._persistence) {
        const queue = createPersistentOfflineQueue(this._persistence, this.config.scope.rootEntity);
        this._queue = queue;
        if (this._authenticatedUser && 'setAuthenticatedUser' in queue) {
          (queue as OfflineQueueExt).setAuthenticatedUser!(this._authenticatedUser);
        }
      } else {
        this._queue = createInMemoryOfflineQueue(this.config.scope.rootEntity);
      }

      remote.setMutationCallback((mutation) => {
        this.handleRemoteMutation(mutation);
      });

      remote.setConnectionChangeCallback((status) => {
        this._connectionStatus = status;
        for (const listener of this.statusListeners) {
          listener(status);
        }
      });

      remote.setOnConnectedCallback(() => {
        this.onConnected();
      });

      await remote.connect(this.options.remote.serverUrl, this.options.remote.getTicket);
    } else {
      this._connectionStatus = 'offline';
      this.initialSyncDone = true;
    }

    if (this._persistence) {
      this.setupPersistenceSubscriptions();
    }

    this._ready = true;

    if (this._persistence) {
      this._persistence.notifyAllEntitySubscribers();
    }
  }

  destroy(): void {
    this._persistence?.close();
    this._remote?.disconnect();
    this._ready = false;
    this._initPromise = null;
  }

  read(entity: string, id: string): Record<string, unknown> | null {
    return this.memory.read(entity, id);
  }

  getSnapshot(entity: string, scopeId: string): Record<string, unknown>[] {
    return this.memory.getSnapshot(entity, scopeId);
  }

  getSnapshotAsMap(entity: string, scopeId: string): Record<string, Record<string, unknown>> {
    return this.memory.getSnapshotAsMap(entity, scopeId);
  }

  async list(entity: string, filter?: ListFilter): Promise<Record<string, unknown>[]> {
    if (this._persistence) {
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
      return this._persistence.list(entity, options);
    }

    const scopeId = filter?.scopeId ?? '';
    return Promise.resolve(this.memory.list(entity, scopeId));
  }

  async listRootEntities(sort?: SortField[]): Promise<Record<string, unknown>[]> {
    if (!this.initialSyncDone && this._remote) return [];

    if (this._persistence) {
      const { rootEntity } = this.config.scope;
      const options: Record<string, unknown> = {};
      if (sort && sort.length > 0) {
        options.sort = sort;
      }
      return this._persistence.list(rootEntity, options);
    }

    return Promise.resolve(this.memory.list(this.config.scope.rootEntity, ''));
  }

  async getChildCount(entity: string, scopeId: string): Promise<number> {
    if (this._persistence) {
      const { scopeField } = this.config.scope;
      return this._persistence.count(entity, {
        filters: [{ field: scopeField, op: 'eq', value: scopeId }],
      });
    }
    return this.memory.list(entity, scopeId).length;
  }

  async create(
    entity: string,
    scopeId: string,
    data: Record<string, unknown>,
    tag?: string
  ): Promise<string> {
    const { rootEntity } = this.config.scope;
    const id = (data.id as string) || crypto.randomUUID();
    const record = stripNulls({ ...data, id });
    const effectiveScopeId = entity === rootEntity ? id : scopeId;

    this.memory.create(entity, effectiveScopeId, record, tag);

    if (this._persistence) {
      try {
        await this._persistence.create(entity, record);
      } catch (err) {
        console.error(`[Stitch] Persistence create ${entity} failed:`, err);
      }
    }

    if (this._queue && effectiveScopeId) {
      await this._queue.queue({
        op: 'insert',
        entity,
        id,
        scopeId: effectiveScopeId,
        data: record,
      });
    }

    if (this._remote && this._remote.connectionStatus === 'connected' && effectiveScopeId) {
      try {
        await this._remote.syncCreate(entity, effectiveScopeId, record);
        await this._queue?.remove(entity, id, effectiveScopeId, 'insert');
      } catch (err) {
        if (err instanceof OwnershipError) {
          await this._queue?.remove(entity, id, effectiveScopeId, 'insert');
          console.warn(`[Stitch] OwnershipError on create ${entity}/${id}:`, err.message);
          return id;
        }
        if (!isTransientSyncError(err)) {
          console.error(`[Stitch] Failed to sync create ${entity}:`, err);
        }
      }
    }

    return id;
  }

  async update(
    entity: string,
    id: string,
    fields: Record<string, unknown>,
    tag?: string
  ): Promise<void> {
    const { rootEntity, scopeField } = this.config.scope;

    const memExisting = this.memory.read(entity, id);
    let scopeId: string | undefined;

    if (memExisting) {
      scopeId = entity === rootEntity ? id : (memExisting[scopeField] as string | undefined);
      if (scopeId) {
        this.memory.update(entity, id, fields, tag);
      }
    }

    if (this._persistence) {
      if (!scopeId) {
        let existing: Record<string, unknown>;
        try {
          existing = await this._persistence.read(entity, id);
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          if (/not found/i.test(msg)) return;
          throw readErr;
        }
        scopeId = entity === rootEntity ? id : (existing[scopeField] as string | undefined);
        if (scopeId && !memExisting) {
          this.memory.update(entity, id, fields, tag);
        }
      }

      try {
        await this._persistence.update(entity, id, fields);
      } catch (updErr) {
        console.error(`[Stitch] Persistence update ${entity} failed:`, updErr);
      }
    } else if (!memExisting) {
      return;
    }

    if (this._queue && scopeId) {
      await this._queue.queue({ op: 'update', entity, id, scopeId, data: fields });
    }

    if (this._remote && this._remote.connectionStatus === 'connected' && scopeId) {
      try {
        await this._remote.syncUpdate(entity, scopeId, id, fields);
        await this._queue?.remove(entity, id, scopeId, 'update');
      } catch (err) {
        if (err instanceof OwnershipError) {
          await this._queue?.remove(entity, id, scopeId, 'update');
          console.warn(`[Stitch] OwnershipError on update ${entity}/${id}:`, err.message);
          return;
        }
        const isNotFound = err instanceof Error && /not found/i.test(err.message);
        if (isNotFound && entity === rootEntity) {
          try {
            if (this._persistence) {
              await this._persistence.delete(rootEntity, id);
            }
            this.memory.delete(rootEntity, id);
          } catch (cleanupErr) {
            console.error(`[Stitch] Cleanup delete ${rootEntity}/${id} failed:`, cleanupErr);
          }
          await this._queue?.remove(entity, id, scopeId, 'update');
        } else if (isNotFound) {
          try {
            let full: Record<string, unknown>;
            if (this._persistence) {
              full = await this._persistence.read(entity, id);
            } else {
              full = this.memory.read(entity, id) ?? {};
            }
            await this._remote.syncCreate(entity, scopeId, full);
          } catch (createErr) {
            if (createErr instanceof OwnershipError) {
              await this._queue?.remove(entity, id, scopeId, 'update');
              console.warn(`[Stitch] OwnershipError on upsert ${entity}/${id}:`, createErr.message);
              return;
            }
            if (!isTransientSyncError(createErr)) {
              console.error(`[Stitch] Failed to sync upsert ${entity}:`, createErr);
            }
          }
        } else if (!isTransientSyncError(err)) {
          console.error(`[Stitch] Failed to sync update ${entity}:`, err);
        }
      }
    }
  }

  async delete(entity: string, id: string, tag?: string): Promise<void> {
    const { rootEntity, scopeField } = this.config.scope;

    const memExisting = this.memory.read(entity, id);
    let scopeId: string | undefined;

    if (memExisting) {
      scopeId = entity === rootEntity ? id : (memExisting[scopeField] as string | undefined);
      if (scopeId) {
        this.memory.delete(entity, id, tag);
      }
    }

    if (this._persistence) {
      if (!scopeId) {
        let existing: Record<string, unknown>;
        try {
          existing = await this._persistence.read(entity, id);
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          if (/not found/i.test(msg)) return;
          throw readErr;
        }
        scopeId = entity === rootEntity ? id : (existing[scopeField] as string | undefined);
        if (scopeId && !memExisting) {
          this.memory.delete(entity, id, tag);
        }
      }

      try {
        await this._persistence.delete(entity, id);
      } catch (delErr) {
        const msg = delErr instanceof Error ? delErr.message : String(delErr);
        if (/not found/i.test(msg)) return;
        console.error(`[Stitch] Persistence delete ${entity} failed:`, delErr);
      }
    } else if (!memExisting) {
      return;
    }

    if (this._queue && scopeId) {
      await this._queue.queue({ op: 'delete', entity, id, scopeId, data: null });
    }

    if (this._remote && this._remote.connectionStatus === 'connected' && scopeId) {
      try {
        await this._remote.syncDelete(entity, scopeId, id);
        await this._queue?.remove(entity, id, scopeId, 'delete');
      } catch (err) {
        if (err instanceof OwnershipError) {
          await this._queue?.remove(entity, id, scopeId, 'delete');
          console.warn(`[Stitch] OwnershipError on delete ${entity}/${id}:`, err.message);
          return;
        }
        const isNotFound = err instanceof Error && /not found/i.test(err.message);
        if (!isNotFound && !isTransientSyncError(err)) {
          console.error(`[Stitch] Failed to sync delete ${entity}:`, err);
        }
      }
    }
  }

  subscribeToScope(scopeId: string, entity: string, callback: () => void): () => void {
    return this.memory.subscribeToScope(scopeId, entity, callback);
  }

  subscribeToEntity(entity: string, callback: () => void): () => void {
    const memoryUnsub = this.memory.subscribeToEntity(entity, callback);
    if (!this._persistence) return memoryUnsub;
    const persistenceUnsub = this._persistence.subscribe(entity, (data) => {
      if (data === null) return;
      callback();
    });
    return () => {
      memoryUnsub();
      persistenceUnsub();
    };
  }

  onMutation(listener: (event: MutationEvent) => void): () => void {
    return this.memory.onMutation(listener);
  }

  subscribe(
    entity: string,
    callback: (data: unknown, op: 'insert' | 'update' | 'delete') => void
  ): () => void {
    if (this._persistence) {
      return this._persistence.subscribe(entity, callback);
    }

    const memUnsub = this.memory.onMutation((event) => {
      if (event.entity !== entity) return;
      const op = event.operation === 'create' ? 'insert' : event.operation;
      callback(event.data, op as 'insert' | 'update' | 'delete');
    });

    const entry = { entity, callback, memoryUnsub: memUnsub };
    this._earlySubscribers.push(entry);

    return () => {
      memUnsub();
      const idx = this._earlySubscribers.indexOf(entry);
      if (idx >= 0) this._earlySubscribers.splice(idx, 1);
    };
  }

  beginBatch(): void {
    this.memory.beginBatch();
  }

  endBatch(): void {
    this.memory.endBatch();
  }

  async openScope(scopeId: string): Promise<void> {
    if (this.currentScopeId === scopeId) return;

    const { rootEntity, childEntities } = this.config.scope;

    if (this.currentScopeId && this.currentScopeId !== scopeId) {
      const prevScope = this.currentScopeId;
      this.currentScopeId = scopeId;
      this.closeScope(prevScope).catch(() => {});
    } else {
      this.currentScopeId = scopeId;
    }

    if (this._remote && this._remote.connectionStatus === 'connected') {
      if (this._persistence) {
        this._persistence.setSuppressNotifications(true);
      }
      try {
        const state = await this._remote.openScope(scopeId);

        if (this._persistence) {
          const localAccessor = this.createLocalAccessor();
          const versionField = this.config.versionField ?? 'version';

          if (state.root && state.root.id) {
            if (state.root[versionField] != null && typeof state.root[versionField] !== 'number') {
              state.root[versionField] = Number(state.root[versionField]) || 1;
            }
            try {
              await localAccessor.read(rootEntity, state.root.id as string);
              await localAccessor.update(rootEntity, state.root.id as string, state.root);
            } catch {
              await localAccessor.create(rootEntity, state.root);
            }
          } else {
            try {
              await localAccessor.read(rootEntity, scopeId);
            } catch {
              return;
            }
          }

          for (const childEntity of childEntities) {
            const serverChildren = state.children[childEntity] ?? [];
            await this._remote.reconcileChildren(
              scopeId,
              childEntity,
              serverChildren,
              localAccessor,
              this._queue
            );
          }

          for (const mutation of state.bufferedMutations) {
            await this._remote.applyMutationToDb(mutation, localAccessor);
          }

          const bundle = await this.loadScopeFromPersistence(scopeId);
          if (bundle) {
            this.memory.loadScope(scopeId, bundle, 'load');
          }
          await this.loadRootIntoMemory(rootEntity, scopeId);
        } else {
          this.memory.loadScope(scopeId, state.children, 'load');
          if (state.root && state.root.id) {
            this.memory.create(rootEntity, scopeId, state.root, 'load');
          }
        }
      } catch (err) {
        console.error('[Stitch] Failed to open scope from server:', err);
        if (this._persistence) {
          const bundle = await this.loadScopeFromPersistence(scopeId);
          if (bundle) {
            this.memory.loadScope(scopeId, bundle, 'load');
          }
          await this.loadRootIntoMemory(rootEntity, scopeId);
        }
      } finally {
        if (this._persistence) {
          this._persistence.setSuppressNotifications(false);
        }
      }
    } else if (this._persistence) {
      const bundle = await this.loadScopeFromPersistence(scopeId);
      if (bundle) {
        this.memory.loadScope(scopeId, bundle, 'load');
      }
      await this.loadRootIntoMemory(rootEntity, scopeId);
    }
  }

  async closeScope(scopeId: string): Promise<void> {
    if (this._remote) {
      await this._remote.closeScope(scopeId);
    }
    if (this.currentScopeId === scopeId) {
      this.currentScopeId = null;
    }
  }

  loadScope(scopeId: string, data: Record<string, Record<string, unknown>[]>): void {
    this.memory.loadScope(scopeId, data);
  }

  clearScope(scopeId: string): void {
    this.memory.clearScope(scopeId);
  }

  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void {
    if (this._remote) {
      return this._remote.subscribeToConnectionStatus(cb);
    }
    this.statusListeners.add(cb);
    cb(this._connectionStatus);
    return () => this.statusListeners.delete(cb);
  }

  disconnect(): void {
    this._remote?.disconnect();
    this._connectionStatus = 'offline';
  }

  async reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    if (this._remote) {
      await this._remote.reconnect(serverUrl, getTicket);
    }
  }

  setAuthenticatedUser(userId: string): void {
    this._authenticatedUser = userId;
    this._remote?.setAuthenticatedUser(userId);
    if (this._queue && 'setAuthenticatedUser' in this._queue) {
      (this._queue as OfflineQueueExt).setAuthenticatedUser!(userId);
    }
  }

  setSessionInvalidHandler(handler: () => void): void {
    this._remote?.setSessionInvalidHandler(handler);
  }

  setReconnectValidator(validator: () => Promise<void>): void {
    this._remote?.setReconnectValidator(validator);
  }

  resetForLogout(): void {
    this._remote?.resetForLogout();
    this._persistence?.close();
    this._persistence = null;
    this._queue = null;
    this._ready = false;
    this._initPromise = null;
    this.currentScopeId = null;
    this._authenticatedUser = null;
    this.initialSyncDone = false;
    this._connectionStatus = 'offline';
    sessionStorage.removeItem('stitch_cached_user');
    sessionStorage.removeItem('stitch_pending_logout');
  }

  async request(topic: string, payload: unknown): Promise<Record<string, unknown>> {
    if (!this._remote) throw new Error('No remote connection');
    return this._remote.request(topic, payload);
  }

  async readLocalState(entity: string, id: string): Promise<Record<string, unknown> | null> {
    if (this._persistence) {
      return this._persistence.readLocalState(entity, id);
    }
    return this.memory.read(entity, id);
  }

  async updateLocalState(
    entity: string,
    id: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    if (this._persistence) {
      await this._persistence.updateLocalState(entity, id, fields);
    } else {
      const existing = this.memory.read(entity, id);
      if (existing) {
        this.memory.update(entity, id, fields);
      }
    }
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

  private async handleRemoteMutation(mutation: SyncMutation): Promise<void> {
    const localAccessor = this.createLocalAccessor();
    if (this._remote) {
      await this._remote.applyMutationToDb(mutation, localAccessor);
    }

    if (!this._persistence) {
      const { scopeField } = this.config.scope;
      switch (mutation.op) {
        case 'insert':
          if (mutation.data) {
            const sid = mutation.data[scopeField] as string | undefined;
            if (sid) {
              this.memory.create(
                mutation.entity,
                sid,
                { ...mutation.data, id: mutation.id },
                'remote'
              );
            }
          }
          break;
        case 'update':
          if (mutation.data) {
            this.memory.update(mutation.entity, mutation.id, mutation.data, 'remote');
          }
          break;
        case 'delete':
          this.memory.delete(mutation.entity, mutation.id, 'remote');
          break;
      }
    }
  }

  private async onConnected(): Promise<void> {
    try {
      if (this._queue && this._remote) {
        const sender = this.createMutationSender();
        await this._queue.flush(sender);
        await this._queue.flush(sender);
      }
      if (this._remote) {
        const localAccessor = this.createLocalAccessor();
        this.initialSyncDone = false;
        await this._remote.syncRootEntityList(localAccessor, this._queue);
        this.initialSyncDone = true;
      }
    } catch (err) {
      void err;
      this.initialSyncDone = true;
    }
  }

  private createLocalAccessor(): LocalAccessor {
    if (this._persistence) {
      return {
        read: (entity, id) => this._persistence!.read(entity, id),
        list: (entity, options) => this._persistence!.list(entity, options),
        create: (entity, data) => this._persistence!.create(entity, data),
        update: (entity, id, data) => this._persistence!.update(entity, id, data),
        delete: (entity, id) => this._persistence!.delete(entity, id),
      };
    }
    return {
      read: async (entity, id) => {
        const result = this.memory.read(entity, id);
        if (!result) throw new Error(`${entity} ${id} not found`);
        return result;
      },
      list: async (entity, options) => {
        const filters = (options as Record<string, unknown>).filters as
          | Array<{ field: string; op: string; value: unknown }>
          | undefined;
        if (filters && filters.length > 0) {
          const scopeFilter = filters.find((f) => f.field === this.config.scope.scopeField);
          if (scopeFilter) {
            return this.memory.list(entity, scopeFilter.value as string);
          }
        }
        return this.memory.list(entity, '');
      },
      create: async (entity, data) => {
        const { scopeField } = this.config.scope;
        const scopeId = data[scopeField] as string | undefined;
        this.memory.create(entity, scopeId ?? '', data, 'remote');
      },
      update: async (entity, id, data) => {
        this.memory.update(entity, id, data, 'remote');
      },
      delete: async (entity, id) => {
        this.memory.delete(entity, id, 'remote');
      },
    };
  }

  private createMutationSender(): MutationSender {
    return {
      syncCreate: (entity, scopeId, data) => this._remote!.syncCreate(entity, scopeId, data),
      syncUpdate: (entity, scopeId, id, data) =>
        this._remote!.syncUpdate(entity, scopeId, id, data),
      syncDelete: (entity, scopeId, id) => this._remote!.syncDelete(entity, scopeId, id),
      readEntity: async (entity, id) => {
        if (this._persistence) {
          return this._persistence.read(entity, id);
        }
        const result = this.memory.read(entity, id);
        if (!result) throw new Error(`${entity} ${id} not found`);
        return result;
      },
      deleteEntity: async (entity, id) => {
        if (this._persistence) {
          await this._persistence.delete(entity, id);
        }
        this.memory.delete(entity, id);
      },
    };
  }

  private async loadRootIntoMemory(rootEntity: string, scopeId: string): Promise<void> {
    if (!this._persistence) return;
    try {
      const rootRecord = await this._persistence.read(rootEntity, scopeId);
      this.memory.create(rootEntity, scopeId, rootRecord, 'load');
    } catch (readErr) {
      console.debug(`[Stitch] Root entity ${rootEntity}/${scopeId} not in persistence:`, readErr);
    }
  }

  private async loadScopeFromPersistence(
    scopeId: string
  ): Promise<Record<string, Record<string, unknown>[]> | null> {
    if (!this._persistence) return null;
    const { childEntities, scopeField } = this.config.scope;
    const children: Record<string, Record<string, unknown>[]> = {};
    for (const entity of childEntities) {
      children[entity] = await this._persistence.list(entity, {
        filters: [{ field: scopeField, op: 'eq', value: scopeId }],
      });
    }
    return children;
  }

  private setupPersistenceSubscriptions(): void {
    if (!this._persistence) return;

    const { childEntities, scopeField } = this.config.scope;

    for (const entity of childEntities) {
      this._persistence.subscribe(
        entity,
        (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
          if (entityData === null || typeof entityData !== 'object') return;
          const record = entityData as Record<string, unknown>;
          const sid = record[scopeField] as string | undefined;
          if (!sid || sid !== this.currentScopeId) return;

          switch (op) {
            case 'insert':
              this.memory.create(entity, sid, record, 'remote');
              break;
            case 'update':
              this.memory.update(entity, record.id as string, record, 'remote');
              break;
            case 'delete':
              this.memory.delete(entity, record.id as string, 'remote');
              break;
          }
        }
      );
    }
  }
}

export function createStore(config: StoreConfig, options?: StoreOptions): Store {
  return new StoreImpl(config, options ?? {});
}
