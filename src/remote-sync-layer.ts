import type {
  StoreConfig,
  SyncMutation,
  ScopeState,
  ConnectionStatus,
  SortField,
  SyncEngine,
  RemoteSyncLayer,
  LocalAccessor,
  OfflineQueue,
} from './types.ts';
import { createSyncEngine } from './sync-engine.ts';
import { stripNulls } from './internal-utils.ts';

type MutationCallback = (mutation: SyncMutation) => void;
type ConnectionCallback = (status: ConnectionStatus) => void;

class RemoteSyncLayerImpl implements RemoteSyncLayer {
  private sync: SyncEngine | null = null;
  private _connectionStatus: ConnectionStatus = 'offline';
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private sessionInvalidHandler: (() => void) | null = null;
  private reconnectValidator: (() => Promise<void>) | null = null;
  private authenticatedUser: string | null = null;
  private readonly config: StoreConfig;
  private onRemoteMutation: MutationCallback | null = null;
  private onConnectionChange: ConnectionCallback | null = null;
  private onConnected: (() => void) | null = null;
  private initialSyncDone = false;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  get isReconnecting(): boolean {
    return this.sync?.isReconnecting ?? false;
  }

  setMutationCallback(cb: MutationCallback): void {
    this.onRemoteMutation = cb;
  }

  setConnectionChangeCallback(cb: ConnectionCallback): void {
    this.onConnectionChange = cb;
  }

  setOnConnectedCallback(cb: () => void): void {
    this.onConnected = cb;
  }

  async connect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    const clientId = this.getOrCreateClientId();
    const syncEngine = createSyncEngine(clientId, this.config);
    this.sync = syncEngine;

    syncEngine.setMutationHandler((_scopeId, mutation) => {
      this.onRemoteMutation?.(mutation);
    });

    syncEngine.setSessionInvalidHandler(() => {
      this.handleSessionInvalid();
    });

    syncEngine.setConnectionStatusHandler((status) => {
      this.setConnectionStatus(status);
      this.onConnectionChange?.(status);
      if (status === 'connected') {
        this.onConnected?.();
        this.revalidateSessionOnReconnect();
      }
    });

    try {
      const wasmModule = await import('mqtt5-wasm');
      await syncEngine.connect(serverUrl, wasmModule, getTicket);
    } catch (err) {
      console.warn('[RemoteSyncLayer] Failed to connect, reconnecting in background:', err);
      this.initialSyncDone = true;
    }
  }

  disconnect(): void {
    this.sync?.disconnect();
    this.setConnectionStatus('offline');
  }

  async reconnect(serverUrl: string, getTicket?: () => Promise<string>): Promise<void> {
    if (!this.sync) return;
    if (this.sync.isReconnecting) return;

    try {
      await this.sync.reconnect(serverUrl, getTicket);
    } catch (err) {
      console.warn('[RemoteSyncLayer] Reconnect failed, working offline:', err);
      this.setConnectionStatus('offline');
    }
  }

  subscribeToConnectionStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this._connectionStatus);
    return () => this.statusListeners.delete(cb);
  }

  setAuthenticatedUser(userId: string): void {
    this.authenticatedUser = userId;
  }

  setSessionInvalidHandler(handler: () => void): void {
    this.sessionInvalidHandler = handler;
  }

  setReconnectValidator(validator: () => Promise<void>): void {
    this.reconnectValidator = validator;
  }

  async syncCreate(entity: string, scopeId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.sync) throw new Error('Not connected');
    const { rootEntity, childEntities } = this.config.scope;
    const isChild = childEntities.includes(entity);
    const isTopLevel = this.config.topLevelEntities?.some((t) => t.entity === entity);

    if (entity === rootEntity || isTopLevel) {
      await this.sync.createEntity(entity, null, data);
    } else if (isChild) {
      await this.sync.createEntity(entity, scopeId, data);
    }
  }

  async syncUpdate(
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

  async syncDelete(entity: string, scopeId: string, id: string): Promise<void> {
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

  async openScope(scopeId: string): Promise<ScopeState> {
    if (!this.sync) throw new Error('Not connected');
    return this.sync.openScope(scopeId);
  }

  async closeScope(scopeId: string): Promise<void> {
    if (this.sync) {
      await this.sync.closeScope(scopeId);
    }
  }

  async fetchList(
    entity: string,
    scopeId?: string,
    sort?: SortField[]
  ): Promise<Record<string, unknown>[] | null> {
    if (!this.sync) return null;
    return this.sync.fetchList(entity, scopeId, sort);
  }

  async syncRootEntityList(
    localAccessor: LocalAccessor,
    queue: OfflineQueue | null
  ): Promise<void> {
    if (!this.sync) return;

    const { rootEntity, childEntities } = this.config.scope;
    const userScopeField = this.config.userScopeField;
    const versionField = this.config.versionField ?? 'version';

    this.initialSyncDone = false;

    const allEntities = await this.sync.fetchList(rootEntity);
    if (allEntities === null) {
      console.warn('[RemoteSyncLayer] fetchList returned null — server unreachable?');
      this.initialSyncDone = true;
      return;
    }

    const currentUser = this.authenticatedUser;
    const serverEntities =
      currentUser && userScopeField
        ? allEntities.filter((d: Record<string, unknown>) => d[userScopeField] === currentUser)
        : allEntities;

    const localEntities = await localAccessor.list(rootEntity, {});
    for (const local of localEntities) {
      const id = local.id as string;
      if (!id) continue;
      if (!currentUser) continue;

      const inServer = serverEntities.some((d: Record<string, unknown>) => (d.id as string) === id);
      if (inServer) continue;

      if (queue) {
        const hasPendingInsert = await queue.hasPendingInsert(rootEntity, id);
        if (hasPendingInsert) {
          console.log('[RemoteSyncLayer] keeping', id, '— has pending insert');
          continue;
        }
      }

      await localAccessor.delete(rootEntity, id);
    }

    for (const entity of serverEntities) {
      const id = entity.id as string;
      if (!id) continue;

      if (queue) {
        const pending = await queue.getPendingForScope(id);
        const hasPendingDelete = pending.some(
          (p) => p.op === 'delete' && p.entity === rootEntity
        );
        if (hasPendingDelete) continue;
      }

      if (entity[versionField] != null && typeof entity[versionField] !== 'number') {
        entity[versionField] = Number(entity[versionField]) || 1;
      }

      try {
        await localAccessor.read(rootEntity, id);
        await localAccessor.update(rootEntity, id, entity);
      } catch {
        await localAccessor.create(rootEntity, entity);
      }

      const childResults = await Promise.all(
        childEntities.map((childEntity) => this.sync!.fetchList(childEntity, id))
      );

      for (let i = 0; i < childEntities.length; i++) {
        const records = childResults[i];
        if (records === null) continue;
        await this.reconcileChildren(id, childEntities[i], records, localAccessor, queue);
      }
    }

    if (this.config.topLevelEntities) {
      for (const topLevel of this.config.topLevelEntities) {
        await this.reconcileTopLevelEntity(topLevel.entity, localAccessor);
      }
    }

    this.initialSyncDone = true;
  }

  get isInitialSyncDone(): boolean {
    return this.initialSyncDone;
  }

  async reconcileChildren(
    scopeId: string,
    entity: string,
    serverRecords: Record<string, unknown>[],
    localAccessor: LocalAccessor,
    queue: OfflineQueue | null
  ): Promise<void> {
    const { scopeField } = this.config.scope;

    const localRecords = await localAccessor.list(entity, {
      filters: [{ field: scopeField, op: 'eq', value: scopeId }],
    });

    let pendingRecords: Array<Record<string, unknown>> = [];
    if (queue) {
      const pending = await queue.getPendingForScope(scopeId);
      pendingRecords = pending
        .filter((p) => p.entity === entity)
        .map((p) => ({
          entityId: p.id,
          op: p.op,
          data: p.data,
        }));
    }

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
        await localAccessor.update(entity, id, cleaned);
      } else {
        await localAccessor.create(entity, cleaned);
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
          await localAccessor.create(entity, p.data as Record<string, unknown>);
        } catch {
          // already exists from a race
        }
      }
    }

    for (const [id] of localMap) {
      if (serverMap.has(id)) continue;
      if (pendingByEntityId.has(id)) continue;
      try {
        await localAccessor.delete(entity, id);
      } catch {
        // already gone
      }
    }
  }

  async applyMutationToDb(
    mutation: SyncMutation,
    localAccessor: LocalAccessor
  ): Promise<void> {
    const { scopeField, rootEntity } = this.config.scope;
    const updatedAtField = this.config.updatedAtField ?? 'updatedAt';

    try {
      switch (mutation.op) {
        case 'insert':
          if (mutation.data) {
            const refScopeId = mutation.data[scopeField] as string | undefined;
            if (refScopeId) {
              try {
                await localAccessor.read(rootEntity, refScopeId);
              } catch (readErr) {
                const msg = readErr instanceof Error ? readErr.message : String(readErr);
                if (/not found/i.test(msg)) return;
                throw readErr;
              }
            }
            await localAccessor.create(mutation.entity, { ...mutation.data, id: mutation.id });
          }
          break;
        case 'update':
          if (mutation.data) {
            try {
              const existing = await localAccessor.read(mutation.entity, mutation.id);
              const remoteVersion = mutation.data._version;
              if (typeof remoteVersion === 'number') {
                const localVersion = typeof existing._version === 'number' ? existing._version : 0;
                if (remoteVersion < localVersion) return;
              }
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
            await localAccessor.update(mutation.entity, mutation.id, mutation.data);
          }
          break;
        case 'delete':
          try {
            await localAccessor.delete(mutation.entity, mutation.id);
          } catch (delErr) {
            const msg = delErr instanceof Error ? delErr.message : String(delErr);
            if (!/not found/i.test(msg)) throw delErr;
          }
          break;
      }
    } catch (err) {
      console.error('[RemoteSyncLayer] Failed to apply remote mutation:', err);
    }
  }

  async request(topic: string, payload: unknown): Promise<Record<string, unknown>> {
    if (!this.sync) throw new Error('Not connected');
    return this.sync.request(topic, payload);
  }

  resetForLogout(): void {
    this.disconnect();
    this.sync = null;
    this.authenticatedUser = null;
    this.sessionInvalidHandler = null;
    this.reconnectValidator = null;
    this.onConnected = null;
    this.initialSyncDone = false;
    this.setConnectionStatus('offline');
    sessionStorage.removeItem('stitch_client_id');
  }

  private async reconcileTopLevelEntity(
    entity: string,
    localAccessor: LocalAccessor
  ): Promise<void> {
    if (!this.sync) return;

    const serverRecords = await this.sync.fetchList(entity);
    if (serverRecords === null) return;

    const serverMap = new Map<string, Record<string, unknown>>();
    for (const r of serverRecords) {
      serverMap.set(r.id as string, r);
    }

    const localRecords = await localAccessor.list(entity, {});
    for (const local of localRecords) {
      const id = local.id as string;
      if (serverMap.has(id)) continue;
      await localAccessor.delete(entity, id);
    }

    for (const serverRecord of serverRecords) {
      const id = serverRecord.id as string;
      try {
        await localAccessor.read(entity, id);
        await localAccessor.update(entity, id, serverRecord);
      } catch {
        await localAccessor.create(entity, serverRecord);
      }
    }
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    this._connectionStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
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

  private revalidateSessionOnReconnect(): void {
    this.reconnectValidator?.().catch(() => {});
  }

  private handleSessionInvalid(): void {
    this.disconnect();
    this.sessionInvalidHandler?.();
  }
}

export function createRemoteSyncLayer(config: StoreConfig): RemoteSyncLayer & {
  setMutationCallback(cb: (mutation: SyncMutation) => void): void;
  setConnectionChangeCallback(cb: (status: ConnectionStatus) => void): void;
  setOnConnectedCallback(cb: () => void): void;
  readonly isInitialSyncDone: boolean;
} {
  return new RemoteSyncLayerImpl(config);
}
