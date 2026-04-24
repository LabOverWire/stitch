import { useEffect, useState } from 'react';
import type { ConnectionStatus, Store } from '../../types.ts';

export function useConnectionStatus(store: Store): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(store.connectionStatus);

  useEffect(() => {
    return store.subscribeToConnectionStatus(setStatus);
  }, [store]);

  return status;
}
