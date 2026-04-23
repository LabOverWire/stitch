import { useEffect, useState, useCallback } from 'react';
import type { Store } from '../../types.ts';

function applyEvent(
  prev: Record<string, unknown>[],
  entity: unknown,
  op: 'insert' | 'update' | 'delete'
): Record<string, unknown>[] {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return prev;
  const entityData = entity as Record<string, unknown>;
  switch (op) {
    case 'insert': {
      const exists = prev.some((item) => item.id === entityData.id);
      if (exists) {
        return prev.map((item) => (item.id === entityData.id ? entityData : item));
      }
      return [...prev, entityData];
    }
    case 'update':
      return prev.map((item) => (item.id === entityData.id ? entityData : item));
    case 'delete':
      return prev.filter((item) => item.id !== entityData.id);
    default:
      return prev;
  }
}

export function useScopedEntities(
  store: Store,
  scopeId: string | null,
  entity: string
): {
  data: Record<string, unknown>[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  const effectiveScopeField = store.config.scope.scopeField;
  const [data, setData] = useState<Record<string, unknown>[]>([]);
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
      setData(entities);
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
          let result = entities;
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
