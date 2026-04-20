import { useEffect, useState } from 'react';
import type { PersistenceStore, Store } from '../../types.ts';

type ListItem = Record<string, unknown> & { id: string };

function applyEvent(
  prev: ListItem[],
  entity: unknown,
  op: 'insert' | 'update' | 'delete'
): ListItem[] {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return prev;
  const item = entity as ListItem;
  switch (op) {
    case 'insert': {
      const exists = prev.some((g) => g.id === item.id);
      if (exists) {
        return prev.map((g) => (g.id === item.id ? item : g));
      }
      return [...prev, item];
    }
    case 'update':
      return prev.map((g) => (g.id === item.id ? item : g));
    case 'delete':
      return prev.filter((g) => g.id !== item.id);
    default:
      return prev;
  }
}

export function useTopLevelEntities(
  store: PersistenceStore | Store,
  entity: string
): {
  items: ListItem[];
  loading: boolean;
} {
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let fetched = false;
    let cancelled = false;
    const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

    const fetchAll = () => {
      store
        .list(entity)
        .then((entities) => {
          if (cancelled) return;
          let result = entities as ListItem[];
          for (const { entity: e, op } of buffer) {
            result = applyEvent(result, e, op);
          }
          buffer.length = 0;
          fetched = true;
          setItems(result);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          fetched = true;
          buffer.length = 0;
          setLoading(false);
        });
    };

    const unsubscribe = store.subscribe(entity, (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
      if (entityData === null) {
        fetchAll();
        return;
      }
      if (!fetched) {
        buffer.push({ entity: entityData, op });
        return;
      }
      setItems((prev) => applyEvent(prev, entityData, op));
    });

    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, entity]);

  return { items, loading };
}
