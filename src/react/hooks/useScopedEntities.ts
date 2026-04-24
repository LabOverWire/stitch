import { useEffect, useState, useCallback } from 'react';
import type { Store } from '../../types.ts';
import { applyEvent, type ListItem } from '../../internal-list-apply.ts';

export function useScopedEntities(
  store: Store,
  scopeId: string | null,
  entity: string
): {
  data: ListItem[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  const effectiveScopeField = store.config.scope.scopeField;
  const [data, setData] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!scopeId) {
      setData([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const entities = await store.list(entity, { scopeId });
      setData(entities as ListItem[]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch entities'));
    } finally {
      setLoading(false);
    }
  }, [store, scopeId, entity]);

  useEffect(() => {
    if (!scopeId) {
      Promise.resolve().then(() => setData([]));
      return;
    }

    let fetched = false;
    let cancelled = false;
    const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

    const fetchAll = () => {
      store
        .list(entity, { scopeId })
        .then((entities) => {
          if (cancelled) return;
          let result = entities as ListItem[];
          for (const { entity: e, op } of buffer) {
            result = applyEvent(result, e, op);
          }
          buffer.length = 0;
          fetched = true;
          setData(result);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          fetched = true;
          buffer.length = 0;
          setError(err instanceof Error ? err : new Error('Failed to fetch entities'));
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
        const rec = entityData as Record<string, unknown>;
        if (rec[effectiveScopeField] !== scopeId) {
          return;
        }

        if (!fetched) {
          buffer.push({ entity: entityData, op });
          return;
        }

        setData((prev) => applyEvent(prev, entityData, op));
      }
    );

    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, scopeId, entity, effectiveScopeField]);

  return { data, loading, error, refetch };
}
