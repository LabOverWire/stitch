import { watch, shallowRef } from 'vue';
import type { ShallowRef } from 'vue';
import type { PersistenceStore, ConnectionStatus, Store } from '../../types.ts';
import { isStore } from '../../internal-utils.ts';

export function useConnectionStatus(store: PersistenceStore | Store): ShallowRef<ConnectionStatus> {
  const initial: ConnectionStatus = isStore(store)
    ? store.connectionStatus
    : store.getConnectionStatus();
  const status = shallowRef<ConnectionStatus>(initial);

  watch(
    () => store,
    (s, _prev, onCleanup) => {
      const unsubscribe = s.subscribeToConnectionStatus((next) => {
        status.value = next;
      });
      onCleanup(unsubscribe);
    },
    { immediate: true }
  );

  return status;
}
