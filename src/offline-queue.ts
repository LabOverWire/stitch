import type {
  PendingMutation,
  ConsolidatedMutation,
  MutationSender,
  OfflineQueue,
  PersistenceLayer,
} from './types.ts';
import { OwnershipError } from './types.ts';
import { isTransientSyncError } from './internal-utils.ts';

function consolidateMutations(records: Array<Record<string, unknown>>): ConsolidatedMutation[] {
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

  const result: Array<ConsolidatedMutation & { minCreatedAt: number }> = [];

  for (const [, entries] of grouped) {
    entries.sort((a, b) => a.createdAt - b.createdAt);

    const recordIds = entries.map((e) => e.recordId);
    const minCreatedAt = entries[0].createdAt;
    const hasInsert = entries.some((e) => e.op === 'insert');
    const hasDelete = entries.some((e) => e.op === 'delete');
    const { entity, entityId, scopeId } = entries[0];

    if (hasInsert && hasDelete) {
      result.push({ op: 'delete', entity, id: entityId, scopeId, data: null, recordIds, minCreatedAt });
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
      result.push({ op: 'insert', entity, id: entityId, scopeId, data: mergedData, recordIds, minCreatedAt });
      continue;
    }

    if (hasDelete) {
      result.push({ op: 'delete', entity, id: entityId, scopeId, data: null, recordIds, minCreatedAt });
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
      minCreatedAt,
    });
  }

  const opPriority: Record<string, number> = { insert: 0, update: 1, delete: 2 };
  result.sort((a, b) => {
    if (a.minCreatedAt !== b.minCreatedAt) return a.minCreatedAt - b.minCreatedAt;
    return (opPriority[a.op] ?? 1) - (opPriority[b.op] ?? 1);
  });

  return result;
}

async function flushConsolidated(
  consolidated: ConsolidatedMutation[],
  sender: MutationSender,
  removeRecords: (ids: string[]) => Promise<void>,
  rootEntity: string
): Promise<void> {
  for (const mutation of consolidated) {
    const { op, entity, id, scopeId, data, recordIds } = mutation;

    try {
      switch (op) {
        case 'insert':
          if (data) {
            await sender.syncCreate(entity, scopeId, data);
          }
          break;
        case 'update':
          if (data) {
            await sender.syncUpdate(entity, scopeId, id, data);
          }
          break;
        case 'delete':
          await sender.syncDelete(entity, scopeId, id);
          break;
      }
      await removeRecords(recordIds);
    } catch (err) {
      const isNotFound = err instanceof Error && /not found/i.test(err.message);
      const isConflict =
        err instanceof Error && /already exists|conflict|duplicate/i.test(err.message);

      if (isNotFound && op === 'update' && entity === rootEntity) {
        try {
          await sender.deleteEntity(entity, id);
        } catch {
          // already gone
        }
        await removeRecords(recordIds);
      } else if (isNotFound && op === 'update') {
        try {
          const full = await sender.readEntity(entity, id);
          await sender.syncCreate(entity, scopeId, full);
          await removeRecords(recordIds);
        } catch (upsertErr) {
          if (!isTransientSyncError(upsertErr)) {
            console.error(
              `[OfflineQueue] Failed to upsert ${entity} during flush:`,
              upsertErr
            );
            await removeRecords(recordIds);
          }
        }
      } else if (isNotFound && op === 'delete') {
        await removeRecords(recordIds);
      } else if (isConflict && op === 'insert') {
        if (data) {
          try {
            await sender.syncUpdate(entity, scopeId, id, data);
            await removeRecords(recordIds);
          } catch (updateErr) {
            if (updateErr instanceof OwnershipError) {
              await removeRecords(recordIds);
            } else if (!isTransientSyncError(updateErr)) {
              console.error(
                `[OfflineQueue] Failed to update-on-conflict ${entity} during flush:`,
                updateErr
              );
            }
          }
        } else {
          await removeRecords(recordIds);
        }
      } else if (err instanceof OwnershipError) {
        await removeRecords(recordIds);
      } else if (isTransientSyncError(err)) {
        // leave for next flush cycle
      } else {
        console.error('[OfflineQueue] Failed to flush mutation:', err);
      }
    }
  }
}

class PersistentOfflineQueue implements OfflineQueue {
  private readonly persistence: PersistenceLayer;
  private readonly rootEntity: string;
  private authenticatedUser: string | null = null;
  private flushing = false;

  constructor(persistence: PersistenceLayer, rootEntity: string) {
    this.persistence = persistence;
    this.rootEntity = rootEntity;
  }

  setAuthenticatedUser(userId: string | null): void {
    this.authenticatedUser = userId;
  }

  async queue(mutation: PendingMutation): Promise<void> {
    if (!this.authenticatedUser) return;
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
      await this.persistence.create('pending_sync', record);
    } catch (err) {
      console.error('[PersistentOfflineQueue] Failed to persist pending mutation:', err);
    }
  }

  async remove(entity: string, entityId: string, scopeId: string, op: string): Promise<void> {
    try {
      const filters: Array<Record<string, unknown>> = [
        { field: 'entity', op: 'eq', value: entity },
        { field: 'entityId', op: 'eq', value: entityId },
        { field: 'scopeId', op: 'eq', value: scopeId },
        { field: 'op', op: 'eq', value: op },
      ];
      if (this.authenticatedUser) {
        filters.push({ field: 'userId', op: 'eq', value: this.authenticatedUser });
      }
      const records = await this.persistence.list('pending_sync', { filters });
      for (const record of records) {
        await this.persistence.delete('pending_sync', record.id as string);
      }
    } catch (err) {
      console.error('[PersistentOfflineQueue] Failed to remove pending mutation:', err);
    }
  }

  async flush(sender: MutationSender): Promise<void> {
    if (this.flushing || !this.authenticatedUser) return;
    this.flushing = true;
    try {
      const pendingRecords = await this.persistence.list('pending_sync', {
        filters: [{ field: 'userId', op: 'eq', value: this.authenticatedUser }],
      });
      if (pendingRecords.length === 0) return;

      const consolidated = consolidateMutations(pendingRecords);
      const removeRecords = async (ids: string[]) => {
        for (const id of ids) {
          try {
            await this.persistence.delete('pending_sync', id);
          } catch {
            // already cleaned up
          }
        }
      };

      await flushConsolidated(consolidated, sender, removeRecords, this.rootEntity);
    } finally {
      this.flushing = false;
    }
  }

  async clear(): Promise<void> {
    if (!this.authenticatedUser) return;
    const records = await this.persistence.list('pending_sync', {
      filters: [{ field: 'userId', op: 'eq', value: this.authenticatedUser }],
    });
    for (const record of records) {
      try {
        await this.persistence.delete('pending_sync', record.id as string);
      } catch {
        // best effort
      }
    }
  }

  async getPendingForScope(scopeId: string): Promise<PendingMutation[]> {
    const filters: Array<Record<string, unknown>> = [
      { field: 'scopeId', op: 'eq', value: scopeId },
    ];
    if (this.authenticatedUser) {
      filters.push({ field: 'userId', op: 'eq', value: this.authenticatedUser });
    }
    const records = await this.persistence.list('pending_sync', { filters });
    return records.map((r) => ({
      op: r.op as PendingMutation['op'],
      entity: r.entity as string,
      id: r.entityId as string,
      scopeId: r.scopeId as string,
      data: (r.data as Record<string, unknown>) || null,
    }));
  }

  async hasPendingInsert(entity: string, entityId: string): Promise<boolean> {
    const records = await this.persistence.list('pending_sync', {
      filters: [
        { field: 'entity', op: 'eq', value: entity },
        { field: 'entityId', op: 'eq', value: entityId },
        { field: 'op', op: 'eq', value: 'insert' },
      ],
    });
    return records.length > 0;
  }
}

class InMemoryOfflineQueue implements OfflineQueue {
  private pending: Array<PendingMutation & { recordId: string; createdAt: number }> = [];
  private readonly rootEntity: string;
  private flushing = false;

  constructor(rootEntity: string) {
    this.rootEntity = rootEntity;
  }

  async queue(mutation: PendingMutation): Promise<void> {
    this.pending.push({
      ...mutation,
      recordId: crypto.randomUUID(),
      createdAt: Date.now(),
    });
  }

  async remove(entity: string, entityId: string, scopeId: string, op: string): Promise<void> {
    this.pending = this.pending.filter(
      (p) => !(p.entity === entity && p.id === entityId && p.scopeId === scopeId && p.op === op)
    );
  }

  async flush(sender: MutationSender): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    try {
      const records = this.pending.map((p) => ({
        id: p.recordId,
        op: p.op,
        entity: p.entity,
        entityId: p.id,
        scopeId: p.scopeId,
        data: p.data,
        createdAt: p.createdAt,
      }));

      const consolidated = consolidateMutations(records as Array<Record<string, unknown>>);
      const flushedIds = new Set<string>();

      const removeRecords = async (ids: string[]) => {
        for (const id of ids) flushedIds.add(id);
      };

      await flushConsolidated(consolidated, sender, removeRecords, this.rootEntity);
      this.pending = this.pending.filter((p) => !flushedIds.has(p.recordId));
    } finally {
      this.flushing = false;
    }
  }

  async clear(): Promise<void> {
    this.pending = [];
  }

  async getPendingForScope(scopeId: string): Promise<PendingMutation[]> {
    return this.pending
      .filter((p) => p.scopeId === scopeId)
      .map((p) => ({ op: p.op, entity: p.entity, id: p.id, scopeId: p.scopeId, data: p.data }));
  }

  async hasPendingInsert(entity: string, entityId: string): Promise<boolean> {
    return this.pending.some(
      (p) => p.entity === entity && p.id === entityId && p.op === 'insert'
    );
  }
}

export function createPersistentOfflineQueue(
  persistence: PersistenceLayer,
  rootEntity: string
): OfflineQueue & { setAuthenticatedUser(userId: string | null): void } {
  return new PersistentOfflineQueue(persistence, rootEntity);
}

export function createInMemoryOfflineQueue(rootEntity: string): OfflineQueue {
  return new InMemoryOfflineQueue(rootEntity);
}
