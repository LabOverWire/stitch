import { watch, shallowRef } from 'vue';
import type { ShallowRef } from 'vue';
import type { ConnectionStatus, Store } from '../../types.ts';

export function useConnectionStatus(store: Store): ShallowRef<ConnectionStatus> {
  const status = shallowRef<ConnectionStatus>(store.connectionStatus);

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
