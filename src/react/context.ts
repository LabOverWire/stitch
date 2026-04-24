import { createContext, useContext } from 'react';
import type { ConnectionStatus, Store } from '../types.ts';

export interface StoreContextValue {
  store: Store;
  initialized: boolean;
  connectionStatus: ConnectionStatus;
  error: Error | null;
}

export const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within a StoreProvider');
  return ctx;
}
