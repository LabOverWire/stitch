import { createContext, useContext } from 'react';
import type { ConnectionStatus, Store } from '../types.ts';

/** @deprecated Use {@link StoreContextValue} — the legacy context will be removed in 0.3. */
export interface StitchContextValue {
  initialized: boolean;
  connectionStatus: ConnectionStatus;
  error: Error | null;
}

/** @deprecated Use {@link StoreContext} — the legacy context will be removed in 0.3. */
export const StitchContext = createContext<StitchContextValue>({
  initialized: false,
  connectionStatus: 'offline',
  error: null,
});

/** @deprecated Use {@link useStore} — the legacy hook will be removed in 0.3. */
export function useStitch(): StitchContextValue {
  return useContext(StitchContext);
}

/** @deprecated Use {@link StoreContextValue} — will be removed in 0.3. */
export type SyncStoreContextValue = StitchContextValue;
/** @deprecated Use {@link StoreContext} — will be removed in 0.3. */
export const SyncStoreContext = StitchContext;
/** @deprecated Use {@link useStore} — will be removed in 0.3. */
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
