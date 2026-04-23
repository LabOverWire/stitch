import { shallowRef, watch, onBeforeUnmount } from 'vue';
import type { ShallowRef } from 'vue';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from './internal-list-apply.ts';

export function useRootEntityList(store: Store): {
  items: ShallowRef<ListItem[]>;
  loading: ShallowRef<boolean>;
  error: ShallowRef<Error | null>;
  refetch: () => Promise<void>;
} {
  const rootEntity = store.config.scope.rootEntity;

  const items = shallowRef<ListItem[]>([]);
  const loading = shallowRef(true);
  const error = shallowRef<Error | null>(null);

  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  async function refetch(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const entities = await store.listRootEntities();
      items.value = entities as ListItem[];
    } catch (err) {
      error.value = err instanceof Error ? err : new Error('Failed to fetch root entities');
    } finally {
      loading.value = false;
    }
  }

  watch(
    () => store,
    (s, _prev, onCleanup) => {
      unsubscribe?.();
      cancelled = false;

      let fetched = false;
      const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

      const fetchAll = () => {
        s.listRootEntities()
          .then((entities) => {
            if (cancelled) return;
            let result = entities as ListItem[];
            for (const { entity, op } of buffer) result = applyEvent(result, entity, op);
            buffer.length = 0;
            fetched = true;
            items.value = result;
            loading.value = false;
          })
          .catch((err) => {
            if (cancelled) return;
            fetched = true;
            buffer.length = 0;
            error.value = err instanceof Error ? err : new Error('Failed to fetch root entities');
            loading.value = false;
          });
      };

      unsubscribe = s.subscribe(rootEntity, (entity: unknown, op) => {
        if (entity === null) {
          fetchAll();
          return;
        }
        if (!fetched) {
          buffer.push({ entity, op });
          return;
        }
        items.value = applyEvent(items.value, entity, op);
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
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
  });

  return { items, loading, error, refetch };
}
