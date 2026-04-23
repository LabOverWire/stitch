import { useEffect, useState, useCallback, useRef } from 'react';
import type { Store } from '../../types.ts';

export function useSyncScope(
  store: Store,
  scopeId: string | null
): {
  syncing: boolean;
  syncError: Error | null;
  openScope: () => Promise<void>;
  closeScope: () => Promise<void>;
} {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<Error | null>(null);
  const openedRef = useRef<string | null>(null);
  const currentScopeIdRef = useRef(scopeId);

  useEffect(() => {
    currentScopeIdRef.current = scopeId;
  }, [scopeId]);

  const openScope = useCallback(async () => {
    if (!scopeId || openedRef.current === scopeId) return;

    setSyncing(true);
    setSyncError(null);

    try {
      await store.replaceScope(scopeId);
      if (currentScopeIdRef.current === scopeId) {
        openedRef.current = scopeId;
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err : new Error('Failed to open scope'));
    } finally {
      setSyncing(false);
    }
  }, [store, scopeId]);

  const closeScope = useCallback(async () => {
    if (!openedRef.current) return;

    try {
      await store.closeScope(openedRef.current);
      openedRef.current = null;
    } catch (err) {
      console.error('[useSyncScope] Failed to close scope:', err);
    }
  }, [store]);

  useEffect(() => {
    return () => {
      if (openedRef.current) {
        store.closeScope(openedRef.current).catch(() => {});
        openedRef.current = null;
      }
    };
  }, [store, scopeId]);

  return { syncing, syncError, openScope, closeScope };
}
