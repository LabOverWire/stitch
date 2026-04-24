import { useEffect, useState, useMemo, type ReactNode } from 'react';
import type { ConnectionStatus, Store } from '../types.ts';
import { StoreContext } from './context.ts';

interface StoreProviderProps {
  store: Store;
  serverUrl?: string;
  getTicket?: () => Promise<string>;
  children: ReactNode;
}

/**
 * Store lifecycle only — initializes the store, tracks connection status, and
 * handles visibility-change reconnection. Authentication concerns (userId, session
 * handlers, logout gating) live in {@link AuthProvider}; compose both if you need
 * an auth-aware app.
 */
export function StoreProvider({ store, serverUrl, getTicket, children }: StoreProviderProps) {
  const [initialized, setInitialized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        if (!store.ready) {
          await store.initialize();
        }
        if (mounted) setInitialized(true);
      } catch (err) {
        console.error('[StoreProvider] Initialization failed:', err);
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Store initialization failed'));
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [store]);

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
    if (!initialized || !store.hasRemote) return;

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
              console.error('[StoreProvider] Reconnect on wake failed:', err)
            );
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [initialized, store, serverUrl, getTicket]);

  const contextValue = useMemo(
    () => ({ store, initialized, connectionStatus, error }),
    [store, initialized, connectionStatus, error]
  );

  return <StoreContext.Provider value={contextValue}>{children}</StoreContext.Provider>;
}

interface AuthProviderProps {
  store: Store;
  userId?: string;
  /** When false, the store is torn down via `resetForLogout()` and remote sync disconnects. Defaults to `true`. */
  authenticated?: boolean;
  onSessionInvalid?: () => void;
  onReconnectValidate?: () => Promise<void>;
  children?: ReactNode;
}

/**
 * Binds authentication-related state to the store. Nest inside a {@link StoreProvider}.
 * Controls `setAuthenticatedUser`, session-invalid + reconnect-validator handlers, and
 * tears down the store via `resetForLogout()` when `authenticated` transitions to false.
 */
export function AuthProvider({
  store,
  userId,
  authenticated = true,
  onSessionInvalid,
  onReconnectValidate,
  children,
}: AuthProviderProps) {
  useEffect(() => {
    if (!authenticated) {
      store.disconnect();
      store.resetForLogout();
      return;
    }
    if (userId) store.setAuthenticatedUser(userId);
    if (onSessionInvalid) store.setSessionInvalidHandler(onSessionInvalid);
    if (onReconnectValidate) store.setReconnectValidator(onReconnectValidate);
  }, [store, userId, authenticated, onSessionInvalid, onReconnectValidate]);

  return <>{children}</>;
}
