import { createContext, useContext } from 'react';
import type { ConnectionStatus, Store } from '../types.ts';

export interface StitchContextValue {
  initialized: boolean;
  connectionStatus: ConnectionStatus;
  error: Error | null;
}

export const StitchContext = createContext<StitchContextValue>({
  initialized: false,
  connectionStatus: 'offline',
  error: null,
});

export function useStitch(): StitchContextValue {
  return useContext(StitchContext);
}

/** @deprecated Use StitchContextValue */
export type SyncStoreContextValue = StitchContextValue;
/** @deprecated Use StitchContext */
export const SyncStoreContext = StitchContext;
/** @deprecated Use useStitch */
export const useSyncStore = useStitch;

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
