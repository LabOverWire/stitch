import type { Database } from 'mqdb-wasm';
import type initWasm from 'mqdb-wasm';
import type { StoreConfig, MutationEvent, MemoryStore } from './types.ts';

type SubscriptionCallback = () => void;
type MutationListener = (event: MutationEvent) => void;

interface VersionedSnapshot<T> {
  version: number;
  data: T;
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

function topologicalDeleteOrder(entities: string[], config: StoreConfig): string[] {
  const entitySet = new Set(entities);
  const refCounts = new Map<string, number>();
  for (const e of entities) refCounts.set(e, 0);

  for (const e of entities) {
    const def = config.entities[e];
    if (!def?.foreignKeys) continue;
    for (const fk of def.foreignKeys) {
      if (entitySet.has(fk.references)) {
        refCounts.set(e, (refCounts.get(e) ?? 0) + 1);
      }
    }
  }

  return [...entities].sort((a, b) => (refCounts.get(b) ?? 0) - (refCounts.get(a) ?? 0));
}

class MemoryStoreImpl implements MemoryStore {
  private _db: Database | null = null;
  private _dbReady = false;
  private _initPromise: Promise<void> | null = null;
  private _wasmReady = false;
  private _corrupted = false;
  private _initWasm: typeof initWasm | null = null;
  private _Database: (new () => Database) | null = null;

  private readonly config: StoreConfig;
  private readonly allEntities: string[];

  private versions: Map<string, Map<string, number>> = new Map();
  private listSnapshots: Map<string, Map<string, VersionedSnapshot<Record<string, unknown>[]>>> =
    new Map();
  private mapSnapshots: Map<
    string,
    Map<string, VersionedSnapshot<Record<string, Record<string, unknown>>>>
  > = new Map();

  private subscribers: Map<string, Map<string, Set<SubscriptionCallback>>> = new Map();
  private globalSubscribers: Map<string, Set<SubscriptionCallback>> = new Map();
  private mutationListeners: Set<MutationListener> = new Set();

  private batchDepth = 0;
  private batchedKeys: Set<string> = new Set();
  private batchedMutations: MutationEvent[] = [];
  private originTag: string | null = null;
  private wasmSubIds: string[] = [];
  private lastOriginTag: string | null = null;
  private pendingDeleteContext: { scopeId: string } | null = null;
  private pendingInitCallbacks: Array<() => void> = [];
  private corruptionCallbacks: Set<() => void> = new Set();

  constructor(config: StoreConfig) {
    this.config = config;
    this.allEntities = [
      config.scope.rootEntity,
      ...config.scope.childEntities,
      ...(config.topLevelEntities?.map((t) => t.entity) ?? []),
    ];
  }

  ensureReady(): Promise<void> {
    if (this._dbReady) return Promise.resolve();
    if (!this._initPromise) {
      this._initPromise = this.doInit();
    }
    return this._initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      if (!this._initWasm) {
        const mod = await import('mqdb-wasm');
        this._initWasm = mod.default;
        this._Database = mod.Database;
      }
      await this._initWasm!();
      this._wasmReady = true;
      this.initDb();
      this.notifyAllGlobalSubscribers();
      const cbs = this.pendingInitCallbacks;
      this.pendingInitCallbacks = [];
      for (const cb of cbs) cb();
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  private initDb(): void {
    if (this._dbReady) return;
    if (!this._wasmReady || !this._Database) return;
    this._db = new this._Database();
    this._dbReady = true;
    this.registerSchemas();
    this.setupSubscriptions();
  }

  get isReady(): boolean {
    return this._dbReady;
  }

  get corrupted(): boolean {
    return this._corrupted;
  }

  onCorruption(callback: () => void): () => void {
    this.corruptionCallbacks.add(callback);
    return () => {
      this.corruptionCallbacks.delete(callback);
    };
  }

  private get db(): Database {
    if (this._corrupted) {
      if (!this.tryRecover()) {
        throw new Error('WASM database is corrupted');
      }
    }
    if (!this._dbReady) {
      this.ensureReady();
      throw new Error('WASM not initialized yet');
    }
    return this._db!;
  }

  private tryRecover(): boolean {
    if (!this._wasmReady || !this._Database) return false;
    try {
      const testDb = new this._Database();
      testDb.listSync('__test__', {});
      testDb.free();
    } catch {
      return false;
    }
    try {
      this._db = new this._Database();
      this._corrupted = false;
      this._dbReady = true;
      this.registerSchemas();
      this.setupSubscriptions();
      this.clearAllCaches();
      console.warn('[MemoryStore] WASM recovered — reinitialized in-memory database');
      return true;
    } catch {
      return false;
    }
  }

  private isWasmCorrupted(err: unknown): boolean {
    if (err instanceof Error && err.name === 'RuntimeError') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /transaction.*null|arg0 is null|transaction error|unreachable/i.test(msg);
  }

  private notifyCorruption(): void {
    for (const cb of this.corruptionCallbacks) {
      try {
        cb();
      } catch {
        // best-effort
      }
    }
  }

  private clearAllCaches(): void {
    this.listSnapshots.clear();
    this.mapSnapshots.clear();
    this.versions.clear();
  }

  private notifyAllGlobalSubscribers(): void {
    for (const entity of this.allEntities) {
      const subs = this.globalSubscribers.get(entity);
      if (subs) {
        for (const cb of subs) cb();
      }
    }
    for (const [, scopeMap] of this.subscribers) {
      for (const [, entitySubs] of scopeMap) {
        for (const cb of entitySubs) cb();
      }
    }
  }

  onReady(callback: () => void): void {
    if (this._dbReady) {
      callback();
    } else {
      this.pendingInitCallbacks.push(callback);
      this.ensureReady();
    }
  }

  private registerSchemasOn(db: Database): void {
    const { entities } = this.config;
    for (const [entity, definition] of Object.entries(entities)) {
      db.addSchema(entity, definition);
      if (definition.indexes) {
        for (const field of definition.indexes) {
          db.addIndex(entity, [field]);
        }
      }
    }
  }

  private registerSchemas(): void {
    this.registerSchemasOn(this._db!);
  }

  private unsubscribeAll(): void {
    if (this._db) {
      for (const subId of this.wasmSubIds) {
        try {
          this._db.unsubscribe(subId);
        } catch {
          // DB may be in a broken state
        }
      }
    }
    this.wasmSubIds = [];
  }

  private setupSubscriptions(): void {
    this.unsubscribeAll();
    for (const entity of this.allEntities) {
      const subId = this.db.subscribe(
        '#',
        entity,
        (event: {
          operation: 'create' | 'update' | 'delete';
          id: string;
          data: Record<string, unknown> | null;
        }) => {
          try {
            this.handleChangeEvent(entity, event);
          } catch (err) {
            console.error(`[MemoryStore] subscription callback error for ${entity}:`, err);
          }
        }
      );
      this.wasmSubIds.push(subId);
    }
  }

  private handleChangeEvent(
    entity: string,
    event: {
      operation: 'create' | 'update' | 'delete';
      id: string;
      data: Record<string, unknown> | null;
    }
  ): void {
    this.lastOriginTag = this.originTag;
    const { rootEntity, scopeField } = this.config.scope;

    let scopeId: string | undefined;
    if (event.operation === 'delete') {
      scopeId =
        this.pendingDeleteContext?.scopeId ?? (entity === rootEntity ? event.id : undefined);
      if (!scopeId) return;
    } else if (entity === rootEntity) {
      scopeId = event.id;
    } else {
      scopeId = event.data?.[scopeField] as string | undefined;
      if (!scopeId) return;
    }

    this.bumpVersion(scopeId, entity);

    const mutation: MutationEvent = {
      operation: event.operation,
      entity,
      id: event.id,
      scopeId,
      data: event.data,
      originTag: this.originTag,
    };

    if (this.batchDepth > 0) {
      this.batchedKeys.add(`${scopeId}\0${entity}`);
      this.batchedMutations.push(mutation);
      return;
    }

    this.notifySubscribers(scopeId, entity);
    this.emitMutation(mutation);
  }

  private bumpVersion(scopeId: string, entity: string): void {
    if (!this.versions.has(scopeId)) {
      this.versions.set(scopeId, new Map());
    }
    const entityVersions = this.versions.get(scopeId)!;
    entityVersions.set(entity, (entityVersions.get(entity) ?? 0) + 1);
  }

  private getVersion(scopeId: string, entity: string): number {
    return this.versions.get(scopeId)?.get(entity) ?? 0;
  }

  private notifySubscribers(scopeId: string, entity: string): void {
    const scopeSubs = this.subscribers.get(scopeId)?.get(entity);
    if (scopeSubs) {
      for (const cb of scopeSubs) cb();
    }
    const globalSubs = this.globalSubscribers.get(entity);
    if (globalSubs) {
      for (const cb of globalSubs) cb();
    }
  }

  private emitMutation(event: MutationEvent): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[MemoryStore] mutation listener error:', err);
      }
    }
  }

  onMutation(listener: MutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  getLastOriginTag(): string | null {
    return this.lastOriginTag;
  }

  subscribeToScope(scopeId: string, entity: string, callback: SubscriptionCallback): () => void {
    if (!this.subscribers.has(scopeId)) {
      this.subscribers.set(scopeId, new Map());
    }
    const scopeMap = this.subscribers.get(scopeId)!;
    if (!scopeMap.has(entity)) {
      scopeMap.set(entity, new Set());
    }
    scopeMap.get(entity)!.add(callback);

    return () => {
      scopeMap.get(entity)?.delete(callback);
      if (scopeMap.get(entity)?.size === 0) {
        scopeMap.delete(entity);
      }
      if (scopeMap.size === 0) {
        this.subscribers.delete(scopeId);
      }
    };
  }

  subscribeToEntity(entity: string, callback: SubscriptionCallback): () => void {
    if (!this.globalSubscribers.has(entity)) {
      this.globalSubscribers.set(entity, new Set());
    }
    this.globalSubscribers.get(entity)!.add(callback);
    return () => {
      this.globalSubscribers.get(entity)?.delete(callback);
    };
  }

  private listRecords(entity: string, scopeId: string): Record<string, unknown>[] {
    if (!this._dbReady || this._corrupted) return [];
    const { rootEntity, scopeField } = this.config.scope;
    const filterField = entity === rootEntity ? 'id' : scopeField;
    try {
      return this._db!.listSync(entity, {
        filters: [{ field: filterField, op: 'eq', value: scopeId }],
      }) as Record<string, unknown>[];
    } catch (err) {
      if (this.isWasmCorrupted(err)) {
        console.error(`[MemoryStore] WASM corruption in listSync:`, err);
        this._corrupted = true;
        this.notifyCorruption();
        if (this.tryRecover()) {
          return [];
        }
      } else {
        console.error(`[MemoryStore] listSync failed for ${entity}:`, err);
      }
      return [];
    }
  }

  getSnapshot(entity: string, scopeId: string): Record<string, unknown>[] {
    const version = this.getVersion(scopeId, entity);

    if (!this.listSnapshots.has(scopeId)) {
      this.listSnapshots.set(scopeId, new Map());
    }
    const entityMap = this.listSnapshots.get(scopeId)!;
    const cached = entityMap.get(entity);
    if (cached && cached.version === version) return cached.data;

    const records = this.listRecords(entity, scopeId);
    entityMap.set(entity, { version, data: records });
    return records;
  }

  getSnapshotAsMap(entity: string, scopeId: string): Record<string, Record<string, unknown>> {
    const version = this.getVersion(scopeId, entity);

    if (!this.mapSnapshots.has(scopeId)) {
      this.mapSnapshots.set(scopeId, new Map());
    }
    const entityMap = this.mapSnapshots.get(scopeId)!;
    const cached = entityMap.get(entity);
    if (cached && cached.version === version) return cached.data;

    const records = this.listRecords(entity, scopeId);
    const map: Record<string, Record<string, unknown>> = {};
    for (const r of records) {
      map[r.id as string] = r;
    }
    entityMap.set(entity, { version, data: map });
    return map;
  }

  create(entity: string, scopeId: string, data: Record<string, unknown>, tag?: string): void {
    if (this._corrupted) return;
    try {
      this.originTag = tag ?? null;
      const { rootEntity, scopeField } = this.config.scope;
      const record =
        entity === rootEntity ? stripNulls(data) : stripNulls({ ...data, [scopeField]: scopeId });
      this.db.createSync(entity, record);
    } catch (err) {
      console.error(`[MemoryStore] create ${entity} failed:`, err);
    } finally {
      this.originTag = null;
    }
  }

  update(entity: string, id: string, fields: Record<string, unknown>, tag?: string): void {
    if (this._corrupted) return;
    try {
      this.originTag = tag ?? null;
      this.db.updateSync(entity, id, stripNulls(fields));
    } catch (err) {
      console.error(`[MemoryStore] update ${entity} failed:`, err);
    } finally {
      this.originTag = null;
    }
  }

  read(entity: string, id: string): Record<string, unknown> | null {
    if (this._corrupted) return null;
    try {
      return this.db.readSync(entity, id) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  delete(entity: string, id: string, tag?: string): void {
    if (this._corrupted) return;
    try {
      this.originTag = tag ?? null;
      const record = this.read(entity, id);
      if (!record) return;
      const scopeField = this.config.scope.scopeField;
      this.pendingDeleteContext = { scopeId: record[scopeField] as string };
      this.db.deleteSync(entity, id);
    } catch (err) {
      console.error(`[MemoryStore] delete ${entity} failed:`, err);
    } finally {
      this.originTag = null;
      this.pendingDeleteContext = null;
    }
  }

  list(entity: string, scopeId: string): Record<string, unknown>[] {
    return this.listRecords(entity, scopeId);
  }

  loadScope(scopeId: string, data: Record<string, Record<string, unknown>[]>, tag?: string): void {
    if (!this._Database) return;
    const newDb = new this._Database();
    this.registerSchemasOn(newDb);

    const scopeField = this.config.scope.scopeField;

    for (const [entity, records] of Object.entries(data)) {
      for (const record of records) {
        try {
          const rec = { ...record, [scopeField]: scopeId };
          newDb.createSync(entity, rec);
        } catch (err) {
          console.error(`[MemoryStore] loadScope create ${entity} failed:`, err);
        }
      }
    }

    this.unsubscribeAll();
    this._db = newDb;
    this._corrupted = false;
    this._dbReady = true;
    this.setupSubscriptions();
    this.clearAllCaches();

    this.originTag = tag ?? null;
    try {
      for (const entity of this.allEntities) {
        this.bumpVersion(scopeId, entity);
        this.notifySubscribers(scopeId, entity);
      }
    } finally {
      this.originTag = null;
    }
  }

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth <= 0) return;
    this.batchDepth--;
    if (this.batchDepth > 0) return;

    const keys = this.batchedKeys;
    const mutations = this.batchedMutations;
    this.batchedKeys = new Set();
    this.batchedMutations = [];

    for (const key of keys) {
      try {
        const [scopeId, entity] = key.split('\0') as [string, string];
        this.notifySubscribers(scopeId, entity);
      } catch (err) {
        console.error('[MemoryStore] endBatch subscriber error:', err);
      }
    }
    for (const mutation of mutations) {
      this.emitMutation(mutation);
    }
  }

  clearScope(scopeId: string): void {
    if (this._corrupted) {
      this.clearAllCaches();
      return;
    }
    let recoveredDuringClear = false;
    this.originTag = 'clear';
    this.beginBatch();
    try {
      for (const entity of topologicalDeleteOrder(this.allEntities, this.config)) {
        if (this._corrupted) {
          recoveredDuringClear = true;
          break;
        }
        const records = this.listRecords(entity, scopeId);
        if (this._corrupted) {
          recoveredDuringClear = true;
          break;
        }
        for (const record of records) {
          try {
            this.pendingDeleteContext = { scopeId };
            this.db.deleteSync(entity, record.id as string);
          } catch {
            // cascade
          } finally {
            this.pendingDeleteContext = null;
          }
        }
      }
    } finally {
      this.originTag = null;
      if (recoveredDuringClear) {
        this.batchDepth = Math.max(0, this.batchDepth - 1);
        this.batchedKeys = new Set();
        this.batchedMutations = [];
      } else {
        this.endBatch();
      }
    }

    if (this.listSnapshots.has(scopeId)) {
      this.listSnapshots.delete(scopeId);
    }
    if (this.mapSnapshots.has(scopeId)) {
      this.mapSnapshots.delete(scopeId);
    }
    this.versions.delete(scopeId);
  }
}

export function createMemoryStore(config: StoreConfig): MemoryStore {
  return new MemoryStoreImpl(config);
}
