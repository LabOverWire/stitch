import { useEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import type {
  MemoryStore,
  PersistenceStore,
  StoreConfig,
  ConnectionStatus,
  Store,
} from '../types.ts';
import { StitchContext, StoreContext } from './context.ts';

interface StitchProviderProps {
  memoryStore: MemoryStore;
  persistenceStore: PersistenceStore;
  config: StoreConfig;
  serverUrl: string;
  getTicket?: () => Promise<string>;
  onSessionInvalid?: () => void;
  onReconnectValidate?: () => Promise<void>;
  userId?: string;
  authenticated?: boolean;
  children: ReactNode;
}

export function StitchProvider({
  memoryStore,
  persistenceStore,
  serverUrl,
  getTicket,
  onSessionInvalid,
  onReconnectValidate,
  userId,
  authenticated = true,
  children,
}: StitchProviderProps) {
  const [initialized, setInitialized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [error, setError] = useState<Error | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!authenticated) {
      if (initializedRef.current) {
        persistenceStore.disconnect();
        persistenceStore.resetForLogout();
        initializedRef.current = false;
        setInitialized(false);
      }
      return;
    }

    let mounted = true;

    async function init() {
      try {
        if (persistenceStore.isInitialized()) {
          if (userId) {
            persistenceStore.setAuthenticatedUser(userId);
          }
          const status = persistenceStore.getConnectionStatus();
          if (
            status !== 'connected' &&
            status !== 'connecting' &&
            !persistenceStore.isReconnecting()
          ) {
            await persistenceStore.reconnect(serverUrl, getTicket);
          }
          if (mounted && !initializedRef.current) {
            initializedRef.current = true;
            setInitialized(true);
          }
          return;
        }

        if (userId) {
          persistenceStore.setAuthenticatedUser(userId);
        }

        await persistenceStore.initialize(serverUrl, getTicket);
        if (!mounted) return;

        if (onSessionInvalid) {
          persistenceStore.setSessionInvalidHandler(onSessionInvalid);
        }

        if (onReconnectValidate) {
          persistenceStore.setReconnectValidator(onReconnectValidate);
        }

        if (mounted) {
          initializedRef.current = true;
          setInitialized(true);
        }
      } catch (err) {
        console.error('[StitchProvider] Initialization failed:', err);
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Stitch initialization failed'));
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [
    authenticated,
    serverUrl,
    userId,
    getTicket,
    onSessionInvalid,
    onReconnectValidate,
    persistenceStore,
  ]);

  useEffect(() => {
    const unsubscribe = persistenceStore.subscribeToConnectionStatus((status) => {
      setConnectionStatus(status);
    });

    function handleBeforeUnload() {
      persistenceStore.disconnect();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [persistenceStore]);

  useEffect(() => {
    const unsubscribe = memoryStore.onCorruption(() => {
      persistenceStore.notifyCorruption();
    });
    return unsubscribe;
  }, [memoryStore, persistenceStore]);

  useEffect(() => {
    if (!authenticated || !initializedRef.current) return;

    let lastHidden = 0;
    const STALE_THRESHOLD_MS = 30_000;

    function handleVisibilityChange() {
      if (document.hidden) {
        lastHidden = Date.now();
        return;
      }

      if (lastHidden > 0 && Date.now() - lastHidden > STALE_THRESHOLD_MS) {
        const status = persistenceStore.getConnectionStatus();
        if (status !== 'connected' && !persistenceStore.isReconnecting()) {
          persistenceStore
            .reconnect(serverUrl, getTicket)
            .catch((err) => console.error('[StitchProvider] Reconnect on wake failed:', err));
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authenticated, initialized, persistenceStore, serverUrl, getTicket]);

  const contextValue = useMemo(
    () => ({ initialized: initialized && authenticated, connectionStatus, error }),
    [initialized, authenticated, connectionStatus, error]
  );

  return <StitchContext.Provider value={contextValue}>{children}</StitchContext.Provider>;
}

/** @deprecated Use StitchProvider */
export const SyncStoreProvider = StitchProvider;

interface StoreProviderProps {
  store: Store;
  serverUrl?: string;
  getTicket?: () => Promise<string>;
  userId?: string;
  authenticated?: boolean;
  onSessionInvalid?: () => void;
  onReconnectValidate?: () => Promise<void>;
  children: ReactNode;
}

export function StoreProvider({
  store,
  serverUrl,
  getTicket,
  userId,
  authenticated = true,
  onSessionInvalid,
  onReconnectValidate,
  children,
}: StoreProviderProps) {
  const [initialized, setInitialized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [error, setError] = useState<Error | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!authenticated) {
      if (initializedRef.current) {
        store.disconnect();
        store.resetForLogout();
        initializedRef.current = false;
        setInitialized(false);
      }
      return;
    }

    let mounted = true;

    async function init() {
      try {
        if (userId) {
          store.setAuthenticatedUser(userId);
        }

        if (onSessionInvalid) {
          store.setSessionInvalidHandler(onSessionInvalid);
        }

        if (onReconnectValidate) {
          store.setReconnectValidator(onReconnectValidate);
        }

        if (!store.ready) {
          await store.initialize();
        }

        if (mounted) {
          initializedRef.current = true;
          setInitialized(true);
        }
      } catch (err) {
        console.error('[StitchProvider] Initialization failed:', err);
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Store initialization failed'));
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [authenticated, userId, onSessionInvalid, onReconnectValidate, store]);

  useEffect(() => {
    const unsubscribe = store.subscribeToConnectionStatus((status) => {
      setConnectionStatus(status);
    });

    function handleBeforeUnload() {
      store.disconnect();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unsubscribe();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [store]);

  useEffect(() => {
    if (!authenticated || !initializedRef.current || !store.hasRemote) return;

    let lastHidden = 0;
    const STALE_THRESHOLD_MS = 30_000;

    function handleVisibilityChange() {
      if (document.hidden) {
        lastHidden = Date.now();
        return;
      }

      if (lastHidden > 0 && Date.now() - lastHidden > STALE_THRESHOLD_MS && serverUrl) {
        if (store.connectionStatus !== 'connected' && !store.isReconnecting) {
          store
            .reconnect(serverUrl, getTicket)
            .catch((err: unknown) =>
              console.error('[StitchProvider] Reconnect on wake failed:', err)
            );
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authenticated, initialized, store, serverUrl, getTicket]);

  const contextValue = useMemo(
    () => ({ store, initialized: initialized && authenticated, connectionStatus, error }),
    [store, initialized, authenticated, connectionStatus, error]
  );

  return <StoreContext.Provider value={contextValue}>{children}</StoreContext.Provider>;
}
