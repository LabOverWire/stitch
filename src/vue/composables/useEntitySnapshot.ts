import { watch, shallowRef, toValue } from 'vue';
import type { ShallowRef, MaybeRefOrGetter } from 'vue';
import type { MemoryStore, Store } from '../../types.ts';

const EMPTY_ARRAY: Record<string, unknown>[] = [];
const EMPTY_MAP: Record<string, Record<string, unknown>> = {};

function resolveMemory(storeOrMemory: MemoryStore | Store): MemoryStore {
  if ('memory' in storeOrMemory) return (storeOrMemory as Store).memory;
  return storeOrMemory as MemoryStore;
}

export function useEntitySnapshot(
  store: MemoryStore | Store,
  scopeId: MaybeRefOrGetter<string>,
  entity: MaybeRefOrGetter<string>
): ShallowRef<Record<string, unknown>[]> {
  const memory = resolveMemory(store);
  const snapshot = shallowRef<Record<string, unknown>[]>(EMPTY_ARRAY);

  watch(
    () => [toValue(scopeId), toValue(entity)] as const,
    ([sid, ent], _prev, onCleanup) => {
      if (!sid) {
        snapshot.value = EMPTY_ARRAY;
        return;
      }
      snapshot.value = memory.getSnapshot(ent, sid);
      const unsubscribe = memory.subscribeToScope(sid, ent, () => {
        snapshot.value = memory.getSnapshot(ent, sid);
      });
      onCleanup(unsubscribe);
    },
    { immediate: true }
  );

  return snapshot;
}

export function useEntitySnapshotAsMap(
  store: MemoryStore | Store,
  scopeId: MaybeRefOrGetter<string>,
  entity: MaybeRefOrGetter<string>
): ShallowRef<Record<string, Record<string, unknown>>> {
  const memory = resolveMemory(store);
  const snapshot = shallowRef<Record<string, Record<string, unknown>>>(EMPTY_MAP);

  watch(
    () => [toValue(scopeId), toValue(entity)] as const,
    ([sid, ent], _prev, onCleanup) => {
      if (!sid) {
        snapshot.value = EMPTY_MAP;
        return;
      }
      snapshot.value = memory.getSnapshotAsMap(ent, sid);
      const unsubscribe = memory.subscribeToScope(sid, ent, () => {
        snapshot.value = memory.getSnapshotAsMap(ent, sid);
      });
      onCleanup(unsubscribe);
    },
    { immediate: true }
  );

  return snapshot;
}
