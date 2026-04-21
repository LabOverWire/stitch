import { useEffect, useState } from 'react';
import type { PersistenceStore, StoreConfig, Store } from '../../types.ts';
import { isStore } from '../../internal-utils.ts';

export function useChildCounts(store: Store, entity: string): Map<string, number>;
export function useChildCounts(
  store: PersistenceStore,
  config: StoreConfig,
  entity: string
): Map<string, number>;
export function useChildCounts(
  store: PersistenceStore | Store,
  configOrEntity: StoreConfig | string,
  entityArg?: string
): Map<string, number> {
  const entity = typeof configOrEntity === 'string' ? configOrEntity : entityArg!;
  const scopeField = isStore(store)
    ? store.config.scope.scopeField
    : (configOrEntity as StoreConfig).scope.scopeField;

  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let fetched = false;
    let cancelled = false;
    const buffer: Array<{ entity: unknown; op: 'insert' | 'update' | 'delete' }> = [];

    const fetchAll = () => {
      store
        .list(entity, { projection: ['id', scopeField] })
        .then((records) => {
          if (cancelled) return;
          const countMap = new Map<string, number>();
          for (const record of records) {
            const sid = record[scopeField] as string;
            if (sid) {
              countMap.set(sid, (countMap.get(sid) ?? 0) + 1);
            }
          }

          for (const { entity: e, op } of buffer) {
            if (op === 'update') continue;
            const n = e as Record<string, unknown>;
            const sid = n[scopeField] as string;
            if (!sid) continue;
            const current = countMap.get(sid) ?? 0;
            if (op === 'insert') {
              countMap.set(sid, current + 1);
            } else if (op === 'delete') {
              countMap.set(sid, Math.max(0, current - 1));
            }
          }
          buffer.length = 0;
          fetched = true;
          setCounts(countMap);
        })
        .catch(() => {
          if (cancelled) return;
          fetched = true;
          buffer.length = 0;
        });
    };

    const unsubscribe = store.subscribe(
      entity,
      (entityData: unknown, op: 'insert' | 'update' | 'delete') => {
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

        setCounts((prev) => {
          const next = new Map(prev);
          const current = next.get(sid) ?? 0;
          if (op === 'insert') {
            next.set(sid, current + 1);
          } else if (op === 'delete') {
            next.set(sid, Math.max(0, current - 1));
          }
          return next;
        });
      }
    );

    fetchAll();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store, entity, scopeField]);

  return counts;
}
