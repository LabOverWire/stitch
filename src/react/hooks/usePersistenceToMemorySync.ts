import { useEffect } from 'react';
import type { MemoryStore, PersistenceStore, StoreConfig } from '../../types.ts';
import { useStitch } from '../context.ts';

/**
 * @deprecated `createStore()` wires persistence → memory sync internally; this hook is
 * only needed with the legacy `StitchProvider` path. Will be removed in 0.3.
 */
export function usePersistenceToMemorySync(
  persistence: PersistenceStore,
  memory: MemoryStore,
  scopeId: string | null,
  config: StoreConfig
): { isConnected: boolean } {
  const { initialized, connectionStatus } = useStitch();

  useEffect(() => {
    if (!initialized || !scopeId) return;

    return () => {
      persistence.closeScope(scopeId!).catch(() => {});
    };
  }, [initialized, scopeId, persistence]);

  useEffect(() => {
    if (!initialized || !scopeId) return;

    const { childEntities, scopeField } = config.scope;

    const unsubscribes: Array<() => void> = [];

    for (const entity of childEntities) {
      const unsub = persistence.subscribe(entity, (entityData, op) => {
        if (entityData === null || typeof entityData !== 'object') return;
        const record = entityData as Record<string, unknown>;
        if (record[scopeField] !== scopeId) return;

        switch (op) {
          case 'insert':
            memory.create(entity, scopeId, record, 'remote');
            break;
          case 'update':
            memory.update(entity, record.id as string, record, 'remote');
            break;
          case 'delete':
            memory.delete(entity, record.id as string, 'remote');
            break;
        }
      });
      unsubscribes.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribes) unsub();
    };
  }, [initialized, scopeId, persistence, memory, config]);

  return {
    isConnected: connectionStatus === 'connected',
  };
}
