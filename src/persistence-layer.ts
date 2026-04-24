import type { Database } from 'mqdb-wasm';
import type { StoreConfig, PersistenceLayer, EntityDefinition } from './types.ts';
import { wrapWasmError, MqdbError } from './internal-wasm-error.ts';

const PENDING_SYNC_DEFINITION: EntityDefinition = {
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
};

type EntitySubscriptionCallback = (entity: unknown, op: 'insert' | 'update' | 'delete') => void;

class PersistenceLayerImpl implements PersistenceLayer {
  private db: Database | null = null;
  private dbName: string | null = null;
  private dbRecovering = false;
  private _dbNeedsRecovery = false;
  private shuttingDown = false;
  private _opQueue: Promise<void> = Promise.resolve();
  private readonly config: StoreConfig;
  private readonly allSyncedEntities: string[];
  private readonly allLocalEntities: string[];
  private entitySubscriptions: Map<string, Set<EntitySubscriptionCallback>> = new Map();
  private wasmSubscriptionIds: Map<string, string> = new Map();
  private suppressEntityNotifications = false;

  constructor(config: StoreConfig) {
    this.config = config;
    this.allSyncedEntities = [
      config.scope.rootEntity,
      ...config.scope.childEntities,
      ...(config.topLevelEntities?.map((t) => t.entity) ?? []),
    ];
    this.allLocalEntities = Object.keys(config.localOnlyEntities ?? {});
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  async open(dbName: string): Promise<void> {
    if (this.db) return;
    const wasmMod = await import('mqdb-wasm');
    try {
      await wasmMod.default();
    } catch (err) {
      throw wrapWasmError('init', err);
    }
    try {
      this.db = await wasmMod.Database.openPersistent(dbName);
      this.dbName = dbName;
    } catch (err) {
      throw wrapWasmError(`openPersistent:${dbName}`, err);
    }
    await this.setupSchemas();
    this.setupWasmSubscriptions();
  }

  close(): void {
    this.shuttingDown = true;
    this._opQueue = Promise.resolve();
    this.unsubscribeAllWasm();
    this.entitySubscriptions.clear();
    if (this.db) {
      try {
        this.db.free();
      } catch {}
    }
    this.db = null;
    this.shuttingDown = false;
  }

  notifyCorruption(): void {
    this._dbNeedsRecovery = true;
    this.serialized('proactiveRecovery', async () => {}).catch(() => {});
  }

  setSuppressNotifications(suppress: boolean): void {
    this.suppressEntityNotifications = suppress;
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

  async create(entity: string, data: Record<string, unknown>): Promise<void> {
    await this.serialized('create:' + entity, async () => {
      if (!this.db) throw new Error('Database not open');
      try {
        await this.db.create(entity, data);
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            await this.db!.create(entity, data);
          } catch (retryErr) {
            throw wrapWasmError(`create:${entity}`, retryErr);
          }
        } else {
          throw wrapWasmError(`create:${entity}`, err);
        }
      }
    });
  }

  async read(entity: string, id: string): Promise<Record<string, unknown>> {
    return this.serialized('read:' + entity, async () => {
      if (!this.db) throw new Error('Database not open');
      try {
        return (await this.db.read(entity, id)) as Record<string, unknown>;
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return (await this.db!.read(entity, id)) as Record<string, unknown>;
          } catch (retryErr) {
            throw wrapWasmError(`read:${entity}`, retryErr);
          }
        }
        throw wrapWasmError(`read:${entity}`, err);
      }
    });
  }

  async update(entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.serialized('update:' + entity, async () => {
      if (!this.db) throw new Error('Database not open');
      try {
        await this.db.update(entity, id, data);
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            await this.db!.update(entity, id, data);
          } catch (retryErr) {
            throw wrapWasmError(`update:${entity}`, retryErr);
          }
        } else {
          throw wrapWasmError(`update:${entity}`, err);
        }
      }
    });
  }

  async delete(entity: string, id: string): Promise<void> {
    await this.serialized('delete:' + entity, async () => {
      if (!this.db) throw new Error('Database not open');
      try {
        await this.db.delete(entity, id);
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            await this.db!.delete(entity, id);
          } catch (retryErr) {
            throw wrapWasmError(`delete:${entity}`, retryErr);
          }
        } else {
          throw wrapWasmError(`delete:${entity}`, err);
        }
      }
    });
  }

  async list(
    entity: string,
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    return this.serialized('list:' + entity, async () => {
      if (!this.db) return [];
      try {
        return (await this.db.list(entity, options ?? {})) as Record<string, unknown>[];
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return (await this.db!.list(entity, options ?? {})) as Record<string, unknown>[];
          } catch {
            return [];
          }
        }
        throw wrapWasmError(`list:${entity}`, err);
      }
    });
  }

  async count(entity: string, options?: Record<string, unknown>): Promise<number> {
    return this.serialized('count:' + entity, async () => {
      if (!this.db) return 0;
      try {
        return await this.db.count(entity, options ?? {});
      } catch (err) {
        if (this.isDbCorrupted(err) && (await this.recoverDb())) {
          try {
            return await this.db!.count(entity, options ?? {});
          } catch {
            return 0;
          }
        }
        return 0;
      }
    });
  }

  subscribe(
    entity: string,
    callback: (data: unknown, op: 'insert' | 'update' | 'delete') => void
  ): () => void {
    let set = this.entitySubscriptions.get(entity);
    if (!set) {
      set = new Set();
      this.entitySubscriptions.set(entity, set);
    }
    set.add(callback);
    return () => {
      const current = this.entitySubscriptions.get(entity);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) this.entitySubscriptions.delete(entity);
    };
  }

  notifyAllEntitySubscribers(): void {
    for (const entity of this.entitySubscriptions.keys()) {
      this.notifyEntitySubscribers(entity, null, 'update');
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
          } catch {}
        }
      },
      5000
    );
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

  private parseOperationFromEvent(
    operation: string | undefined
  ): 'insert' | 'update' | 'delete' | null {
    if (!operation) return null;
    if (operation === 'create') return 'insert';
    if (operation === 'update') return 'update';
    if (operation === 'delete') return 'delete';
    return null;
  }

  private async setupSchemas(): Promise<void> {
    if (!this.db) return;
    const db = this.db;

    const { entities, localOnlyEntities } = this.config;
    const pendingSyncDef = localOnlyEntities?.['pending_sync'];

    const schemaDefs: Array<[string, EntityDefinition]> = [
      ...Object.entries(entities),
      ...Object.entries(localOnlyEntities ?? {}),
    ];
    if (!pendingSyncDef) {
      schemaDefs.push(['pending_sync', PENDING_SYNC_DEFINITION]);
    }

    await Promise.all(
      schemaDefs.map(async ([entity, def]) => {
        try {
          await db.addSchemaAsync(entity, def);
        } catch (err) {
          throw wrapWasmError(`addSchema:${entity}`, err);
        }
      })
    );

    await Promise.all(
      schemaDefs.flatMap(([entity, def]) => [
        ...(def.foreignKeys ?? []).map(async (fk) => {
          try {
            await db.addForeignKeyAsync(entity, fk.field, fk.references, 'id', fk.onDelete);
          } catch (err) {
            throw wrapWasmError(`addForeignKey:${entity}.${fk.field}`, err);
          }
        }),
        ...(def.indexes ?? []).map(async (field) => {
          try {
            await db.addIndexAsync(entity, [field]);
          } catch (err) {
            throw wrapWasmError(`addIndex:${entity}.${field}`, err);
          }
        }),
      ])
    );
  }

  private unsubscribeAllWasm(): void {
    if (this.db) {
      for (const subId of this.wasmSubscriptionIds.values()) {
        try {
          this.db.unsubscribe(subId);
        } catch {}
      }
    }
    this.wasmSubscriptionIds.clear();
  }

  private setupWasmSubscriptions(): void {
    if (!this.db) return;
    this.unsubscribeAllWasm();

    const allEntities = [...this.allSyncedEntities, ...this.allLocalEntities];

    for (const entity of allEntities) {
      let subId: string;
      try {
        subId = this.db.subscribe('#', entity, (event: unknown) => {
          if (this.suppressEntityNotifications) return;
          const evt = event as { operation?: string; data?: unknown };
          const op = this.parseOperationFromEvent(evt.operation);
          if (op) {
            this.notifyEntitySubscribers(entity, evt.data, op);
          }
        });
      } catch (err) {
        throw wrapWasmError(`subscribe:${entity}`, err);
      }
      this.wasmSubscriptionIds.set(entity, subId);
    }
  }

  private isDbCorrupted(err: unknown): boolean {
    const inner = err instanceof MqdbError ? err.cause : err;
    if (inner instanceof Error && inner.name === 'RuntimeError') return true;
    const msg = inner instanceof Error ? inner.message : String(inner);
    return /transaction.*null|arg0 is null|transaction error|index out of bounds|database is busy|unreachable/i.test(
      msg
    );
  }

  private async recoverDb(): Promise<boolean> {
    if (this.dbRecovering) return false;
    this.dbRecovering = true;
    const oldDb = this.db;
    try {
      if (!this.dbName) return false;
      const wasmMod = await import('mqdb-wasm');
      this.db = await wasmMod.Database.openPersistent(this.dbName);
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
}

export function createPersistenceLayer(config: StoreConfig): PersistenceLayer & {
  notifyCorruption(): void;
  setSuppressNotifications(suppress: boolean): void;
  notifyAllEntitySubscribers(): void;
} {
  return new PersistenceLayerImpl(config);
}
