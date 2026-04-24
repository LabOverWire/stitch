import { useEffect, useState, useCallback } from 'react';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from '../../internal-list-apply.ts';

export function useRootEntityList(store: Store): {
  items: ListItem[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  const rootEntity = store.config.scope.rootEntity;

  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entities = await store.listRootEntities();
      setItems(entities as ListItem[]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch root entities'));
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    let fetched = false;
    let cancelled = false;
    const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

    const fetchAll = () => {
      store
        .listRootEntities()
        .then((entities) => {
          if (cancelled) return;
          let result = entities as ListItem[];
          for (const { entity, op } of buffer) {
            result = applyEvent(result, entity, op);
          }
          buffer.length = 0;
          fetched = true;
          setItems(result);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          fetched = true;
          buffer.length = 0;
          setError(err instanceof Error ? err : new Error('Failed to fetch root entities'));
          setLoading(false);
        });
    };

    const unsubscribe = store.subscribeToEntity(
      rootEntity,
      (entity: unknown, op: 'insert' | 'update' | 'delete') => {
        if (entity === null) {
          fetchAll();
          return;
        }
        if (!fetched) {
          buffer.push({ entity, op });
          return;
        }
        setItems((prev) => applyEvent(prev, entity, op));
      }
    );

    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, rootEntity]);

  return { items, loading, error, refetch };
}
