import type { WasmDatabase } from 'mqdb-wasm';
import type { StoreConfig, PersistenceLayer } from './types.ts';

type EntitySubscriptionCallback = (entity: unknown, op: 'insert' | 'update' | 'delete') => void;

class PersistenceLayerImpl implements PersistenceLayer {
  private db: WasmDatabase | null = null;
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
    await wasmMod.default();
    this.db = await (
      wasmMod.WasmDatabase as unknown as {
        open_persistent(name: string): Promise<WasmDatabase>;
      }
    ).open_persistent(dbName);
    this.setupSchemas();
    this.setupWasmSubscriptions();
  }

  close(): void {
    this.shuttingDown = true;
    this._opQueue = Promise.resolve();
    this.unsubscribeAllWasm();
    this.entitySubscriptions.clear();
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
          await this.db!.create(entity, data);
        } else {
          throw err;
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
          return (await this.db!.read(entity, id)) as Record<string, unknown>;
        }
        throw err;
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
          await this.db!.update(entity, id, data);
        } else {
          throw err;
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
          await this.db!.delete(entity, id);
        } else {
          throw err;
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
        throw err;
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
    if (!this.entitySubscriptions.has(entity)) {
      this.entitySubscriptions.set(entity, new Set());
    }
    this.entitySubscriptions.get(entity)!.add(callback);
    return () => {
      this.entitySubscriptions.get(entity)?.delete(callback);
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
          } catch {
            // best effort
          }
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

  private setupSchemas(): void {
    if (!this.db) return;

    const { entities, localOnlyEntities } = this.config;
    for (const [entity, definition] of Object.entries(entities)) {
      this.db.add_schema(entity, definition);
      if (definition.foreignKeys) {
        for (const fk of definition.foreignKeys) {
          this.db.add_foreign_key(entity, fk.field, fk.references, 'id', fk.onDelete);
        }
      }
      if (definition.indexes) {
        for (const field of definition.indexes) {
          this.db.add_index(entity, [field]);
        }
      }
    }

    if (localOnlyEntities) {
      for (const [entity, definition] of Object.entries(localOnlyEntities)) {
        this.db.add_schema(entity, definition);
        if (definition.indexes) {
          for (const field of definition.indexes) {
            this.db.add_index(entity, [field]);
          }
        }
      }
    }

    const pendingSyncDef = this.config.localOnlyEntities?.['pending_sync'];
    if (!pendingSyncDef) {
      this.db.add_schema('pending_sync', {
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
      this.db = await (
        wasmMod.WasmDatabase as unknown as {
          open_persistent(name: string): Promise<WasmDatabase>;
        }
      ).open_persistent(this.config.dbName);
      this.setupSchemas();
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
