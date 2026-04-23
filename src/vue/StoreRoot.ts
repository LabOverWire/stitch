import { defineComponent, provide, shallowRef, onMounted, onUnmounted, watch } from 'vue';
import type { PropType } from 'vue';
import type { ConnectionStatus, Store } from '../types.ts';
import { STITCH_KEY } from './injection-key.ts';

/**
 * Store lifecycle component. Initializes the store, tracks connection status, and
 * handles visibility-change reconnection. Authentication concerns (userId, session
 * handlers, logout gating) live in {@link StitchAuth} — compose both if you need
 * an auth-aware app.
 */
export const StoreRoot = defineComponent({
  name: 'StoreRoot',

  props: {
    store: { type: Object as PropType<Store>, required: true },
    serverUrl: { type: String, default: undefined },
    getTicket: { type: Function as PropType<() => Promise<string>>, default: undefined },
  },

  setup(props, { slots }) {
    const initialized = shallowRef(false);
    const connectionStatus = shallowRef<ConnectionStatus>('offline');
    const error = shallowRef<Error | null>(null);

    const context = {
      get store() {
        return props.store;
      },
      get initialized() {
        return initialized.value;
      },
      get connectionStatus() {
        return connectionStatus.value;
      },
      get error() {
        return error.value;
      },
    };

    provide(STITCH_KEY, context);

    watch(
      () => props.store,
      (store) => {
        let mounted = true;
        async function init() {
          try {
            if (!store.ready) await store.initialize();
            if (mounted) initialized.value = true;
          } catch (err) {
            console.error('[StoreRoot] Initialization failed:', err);
            if (mounted) {
              error.value = err instanceof Error ? err : new Error('Store initialization failed');
            }
          }
        }
        init();
        return () => {
          mounted = false;
        };
      },
      { immediate: true }
    );

    let unsubStatus: (() => void) | null = null;

    function handleBeforeUnload() {
      props.store.disconnect();
    }

    onMounted(() => {
      unsubStatus = props.store.subscribeToConnectionStatus((status) => {
        connectionStatus.value = status;
      });
      window.addEventListener('beforeunload', handleBeforeUnload);
    });

    onUnmounted(() => {
      unsubStatus?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    });

    watch(
      () => [initialized.value, props.store, props.serverUrl, props.getTicket] as const,
      ([ready, store, serverUrl, getTicket]) => {
        if (!ready || !store.hasRemote) return;

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
                  console.error('[StoreRoot] Reconnect on wake failed:', err)
                );
            }
          }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
      },
      { immediate: true }
    );

    return () => slots.default?.();
  },
});
