import { shallowRef, watch, onBeforeUnmount } from 'vue';
import type { ShallowRef } from 'vue';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from '../../internal-list-apply.ts';

export function useTopLevelEntities(
  store: Store,
  entity: string
): {
  items: ShallowRef<ListItem[]>;
  loading: ShallowRef<boolean>;
} {
  const items = shallowRef<ListItem[]>([]);
  const loading = shallowRef(true);
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
        s.list(ent)
          .then((rows) => {
            if (cancelled) return;
            let result = rows as ListItem[];
            for (const { entity: e, op } of buffer) result = applyEvent(result, e, op);
            buffer.length = 0;
            fetched = true;
            items.value = result;
            loading.value = false;
          })
          .catch(() => {
            if (cancelled) return;
            fetched = true;
            buffer.length = 0;
            loading.value = false;
          });
      };

      unsubscribe = s.subscribeToEntity(ent, (entityData, op) => {
        if (entityData === null) {
          fetchAll();
          return;
        }
        if (!fetched) {
          buffer.push({ entity: entityData, op });
          return;
        }
        items.value = applyEvent(items.value, entityData, op);
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

  return { items, loading };
}
