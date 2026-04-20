import { useSyncExternalStore } from 'react';
import type { MemoryStore, Store } from '../../types.ts';

const EMPTY_ARRAY: Record<string, unknown>[] = [];
const EMPTY_MAP: Record<string, Record<string, unknown>> = {};

function resolveMemory(storeOrMemory: MemoryStore | Store): MemoryStore {
  if ('memory' in storeOrMemory) return (storeOrMemory as Store).memory;
  return storeOrMemory as MemoryStore;
}

export function useEntitySnapshot(
  store: MemoryStore | Store,
  scopeId: string,
  entity: string
): Record<string, unknown>[] {
  const memory = resolveMemory(store);
  return useSyncExternalStore(
    (onStoreChange) => {
      if (!scopeId) return () => {};
      return memory.subscribeToScope(scopeId, entity, onStoreChange);
    },
    () => {
      if (!scopeId) return EMPTY_ARRAY;
      return memory.getSnapshot(entity, scopeId);
    }
  );
}

export function useEntitySnapshotAsMap(
  store: MemoryStore | Store,
  scopeId: string,
  entity: string
): Record<string, Record<string, unknown>> {
  const memory = resolveMemory(store);
  return useSyncExternalStore(
    (onStoreChange) => {
      if (!scopeId) return () => {};
      return memory.subscribeToScope(scopeId, entity, onStoreChange);
    },
    () => {
      if (!scopeId) return EMPTY_MAP;
      return memory.getSnapshotAsMap(entity, scopeId);
    }
  );
}
