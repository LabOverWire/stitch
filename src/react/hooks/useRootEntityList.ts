import { useEffect, useState, useCallback } from 'react';
import type { PersistenceStore, StoreConfig, Store } from '../../types.ts';
import { isStore } from '../../internal-utils.ts';

type ListItem = Record<string, unknown> & { id: string };

function applyEvent(prev: ListItem[], entity: unknown, op: 'insert' | 'update' | 'delete'): ListItem[] {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return prev;
  const item = entity as ListItem;
  switch (op) {
    case 'insert': {
      const exists = prev.some((d) => d.id === item.id);
      if (exists) {
        return prev.map((d) => (d.id === item.id ? item : d));
      }
      return [...prev, item];
    }
    case 'update':
      return prev.map((d) => (d.id === item.id ? item : d));
    case 'delete':
      return prev.filter((d) => d.id !== item.id);
    default:
      return prev;
  }
}

export function useRootEntityList(
  store: PersistenceStore | Store,
  config?: StoreConfig
): {
  items: ListItem[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  const rootEntity = isStore(store) ? store.config.scope.rootEntity : config!.scope.rootEntity;

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

    const unsubscribe = store.subscribe(rootEntity, (entity: unknown, op: 'insert' | 'update' | 'delete') => {
      if (entity === null) {
        fetchAll();
        return;
      }
      if (!fetched) {
        buffer.push({ entity, op });
        return;
      }
      setItems((prev) => applyEvent(prev, entity, op));
    });

    setLoading(true);
    setError(null);
    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, rootEntity]);

  return { items, loading, error, refetch };
}
