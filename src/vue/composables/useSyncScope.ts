import { watch, shallowRef, toValue, onUnmounted } from 'vue';
import type { ShallowRef, MaybeRefOrGetter } from 'vue';
import type { Store } from '../../types.ts';

export function useSyncScope(
  store: Store,
  scopeId: MaybeRefOrGetter<string | null>
): {
  syncing: ShallowRef<boolean>;
  syncError: ShallowRef<Error | null>;
  openScope: () => Promise<void>;
  closeScope: () => Promise<void>;
} {
  const syncing = shallowRef(false);
  const syncError = shallowRef<Error | null>(null);
  let openedScopeId: string | null = null;

  async function openScope(): Promise<void> {
    const sid = toValue(scopeId);
    if (!sid || openedScopeId === sid) return;

    syncing.value = true;
    syncError.value = null;

    try {
      await store.replaceScope(sid);
      if (toValue(scopeId) === sid) {
        openedScopeId = sid;
      }
    } catch (err) {
      syncError.value = err instanceof Error ? err : new Error('Failed to open scope');
    } finally {
      syncing.value = false;
    }
  }

  async function closeScope(): Promise<void> {
    if (!openedScopeId) return;

    try {
      await store.closeScope(openedScopeId);
      openedScopeId = null;
    } catch (err) {
      console.error('[useSyncScope] Failed to close scope:', err);
    }
  }

  watch(
    () => toValue(scopeId),
    () => {
      if (openedScopeId) {
        store.closeScope(openedScopeId).catch(() => {});
        openedScopeId = null;
      }
    }
  );

  onUnmounted(() => {
    if (openedScopeId) {
      store.closeScope(openedScopeId).catch(() => {});
      openedScopeId = null;
    }
  });

  return { syncing, syncError, openScope, closeScope };
}
