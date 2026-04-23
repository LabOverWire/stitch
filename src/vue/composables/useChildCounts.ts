import { shallowRef, watch, onBeforeUnmount } from 'vue';
import type { ShallowRef } from 'vue';
import type { Store } from '../../types.ts';

export function useChildCounts(store: Store, entity: string): ShallowRef<Map<string, number>> {
  const scopeField = store.config.scope.scopeField;
  const counts = shallowRef<Map<string, number>>(new Map());
  let unsubscribe: (() => void) | null = null;

  watch(
    () => [store, entity] as const,
    ([s, ent], _prev, onCleanup) => {
      unsubscribe?.();
      unsubscribe = null;

      let fetched = false;
      let cancelled = false;
      const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

      const fetchAll = () => {
        s.list(ent, { projection: ['id', scopeField] })
          .then((records) => {
            if (cancelled) return;
            const next = new Map<string, number>();
            for (const record of records) {
              const sid = record[scopeField] as string;
              if (sid) next.set(sid, (next.get(sid) ?? 0) + 1);
            }
            for (const { entity: e, op } of buffer) {
              if (op === 'update') continue;
              const rec = e as Record<string, unknown>;
              const sid = rec[scopeField] as string;
              if (!sid) continue;
              const current = next.get(sid) ?? 0;
              if (op === 'insert') next.set(sid, current + 1);
              else if (op === 'delete') next.set(sid, Math.max(0, current - 1));
            }
            buffer.length = 0;
            fetched = true;
            counts.value = next;
          })
          .catch(() => {
            if (cancelled) return;
            fetched = true;
            buffer.length = 0;
          });
      };

      unsubscribe = s.subscribe(ent, (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
        if (entityData === null) {
          fetchAll();
          return;
        }
        if (op === 'update') return;
        if (typeof entityData !== 'object') return;
        if (!fetched) {
          buffer.push({ entity: entityData, op });
          return;
        }
        const record = entityData as Record<string, unknown>;
        const sid = record[scopeField] as string;
        if (!sid) return;
        const next = new Map(counts.value);
        const current = next.get(sid) ?? 0;
        if (op === 'insert') next.set(sid, current + 1);
        else if (op === 'delete') next.set(sid, Math.max(0, current - 1));
        counts.value = next;
      });

      fetchAll();

      onCleanup(() => {
        cancelled = true;
        unsubscribe?.();
        unsubscribe = null;
      });
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  return counts;
}
