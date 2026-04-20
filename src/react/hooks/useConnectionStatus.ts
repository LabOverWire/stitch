import { useEffect, useState } from 'react';
import type { PersistenceStore, ConnectionStatus, Store } from '../../types.ts';
import { isStore } from '../../internal-utils.ts';

export function useConnectionStatus(store: PersistenceStore | Store): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(
    isStore(store) ? store.connectionStatus : store.getConnectionStatus()
  );

  useEffect(() => {
    return store.subscribeToConnectionStatus(setStatus);
  }, [store]);

  return status;
}
