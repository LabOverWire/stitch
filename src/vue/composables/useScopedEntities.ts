import { shallowRef, watch, toValue, onBeforeUnmount } from 'vue';
import type { ShallowRef, MaybeRefOrGetter } from 'vue';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from './internal-list-apply.ts';

export function useScopedEntities(
  store: Store,
  scopeId: MaybeRefOrGetter<string | null>,
  entity: MaybeRefOrGetter<string>
): {
  data: ShallowRef<ListItem[]>;
  loading: ShallowRef<boolean>;
  error: ShallowRef<Error | null>;
  refetch: () => Promise<void>;
} {
  const effectiveScopeField = store.config.scope.scopeField;
  const data = shallowRef<ListItem[]>([]);
  const loading = shallowRef(true);
  const error = shallowRef<Error | null>(null);

  async function refetch(): Promise<void> {
    const sid = toValue(scopeId);
    const ent = toValue(entity);
    if (!sid) {
      data.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const rows = await store.list(ent, { scopeId: sid });
      data.value = rows as ListItem[];
    } catch (err) {
      error.value = err instanceof Error ? err : new Error('Failed to fetch entities');
    } finally {
      loading.value = false;
    }
  }

  let unsubscribe: (() => void) | null = null;

  watch(
    () => [toValue(scopeId), toValue(entity)] as const,
    ([sid, ent], _prev, onCleanup) => {
      unsubscribe?.();
      unsubscribe = null;

      if (!sid) {
        data.value = [];
        loading.value = false;
        return;
      }

      let fetched = false;
      let cancelled = false;
      const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

      const fetchAll = () => {
        store
          .list(ent, { scopeId: sid })
          .then((rows) => {
            if (cancelled) return;
            let result = rows as ListItem[];
            for (const { entity: e, op } of buffer) result = applyEvent(result, e, op);
            buffer.length = 0;
            fetched = true;
            data.value = result;
            loading.value = false;
          })
          .catch((err) => {
            if (cancelled) return;
            fetched = true;
            buffer.length = 0;
            error.value = err instanceof Error ? err : new Error('Failed to fetch entities');
            loading.value = false;
          });
      };

      unsubscribe = store.subscribe(
        ent,
        (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
          if (entityData === null) {
            fetchAll();
            return;
          }
          const rec = entityData as Record<string, unknown>;
          if (rec[effectiveScopeField] !== sid) return;
          if (!fetched) {
            buffer.push({ entity: entityData, op });
            return;
          }
          data.value = applyEvent(data.value, entityData, op);
        }
      );

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

  return { data, loading, error, refetch };
}
