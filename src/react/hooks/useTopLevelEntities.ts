import { useEffect, useState } from 'react';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from '../../internal-list-apply.ts';

export function useTopLevelEntities(
  store: Store,
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

    const unsubscribe = store.subscribeToEntity(
      entity,
      (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
        if (entityData === null) {
          fetchAll();
          return;
        }
        if (!fetched) {
          buffer.push({ entity: entityData, op });
          return;
        }
        setItems((prev) => applyEvent(prev, entityData, op));
      }
    );

    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, entity]);

  return { items, loading };
}
