import {
  defineComponent,
  provide,
  shallowRef,
  onMounted,
  onUnmounted,
  watch,
} from 'vue';
import type { PropType } from 'vue';
import type { ConnectionStatus, Store } from '../types.ts';
import { STITCH_KEY } from './injection-key.ts';

export const StitchRoot = defineComponent({
  name: 'StitchRoot',

  props: {
    store: { type: Object as PropType<Store>, required: true },
    serverUrl: { type: String, default: undefined },
    getTicket: { type: Function as PropType<() => Promise<string>>, default: undefined },
    userId: { type: String, default: undefined },
    authenticated: { type: Boolean, default: true },
    onSessionInvalid: { type: Function as PropType<() => void>, default: undefined },
    onReconnectValidate: { type: Function as PropType<() => Promise<void>>, default: undefined },
  },

  setup(props, { slots }) {
    const initialized = shallowRef(false);
    const connectionStatus = shallowRef<ConnectionStatus>('offline');
    const error = shallowRef<Error | null>(null);
    let initializedFlag = false;

    const context = {
      get store() { return props.store; },
      get initialized() { return initialized.value && props.authenticated; },
      get connectionStatus() { return connectionStatus.value; },
      get error() { return error.value; },
    };

    provide(STITCH_KEY, context);

    watch(
      () => [props.authenticated, props.userId, props.onSessionInvalid, props.onReconnectValidate, props.store] as const,
      ([authenticated, userId, sessionHandler, reconnectValidator, store], _prev) => {
        if (!authenticated) {
          if (initializedFlag) {
            store.disconnect();
            store.resetForLogout();
            initializedFlag = false;
            initialized.value = false;
          }
          return;
        }

        let mounted = true;

        async function init() {
          try {
            if (userId) {
              store.setAuthenticatedUser(userId);
            }
            if (sessionHandler) {
              store.setSessionInvalidHandler(sessionHandler);
            }
            if (reconnectValidator) {
              store.setReconnectValidator(reconnectValidator);
            }
            if (!store.ready) {
              await store.initialize();
            }
            if (mounted) {
              initializedFlag = true;
              initialized.value = true;
            }
          } catch (err) {
            console.error('[StitchRoot] Initialization failed:', err);
            if (mounted) {
              error.value = err instanceof Error ? err : new Error('Store initialization failed');
            }
          }
        }

        init();

        return () => { mounted = false; };
      },
      { immediate: true },
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
      () => [props.authenticated, initialized.value, props.store, props.serverUrl, props.getTicket] as const,
      ([authenticated, ready, store, serverUrl, getTicket]) => {
        if (!authenticated || !ready || !store.hasRemote) return;

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
                .catch((err: unknown) => console.error('[StitchRoot] Reconnect on wake failed:', err));
            }
          }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
      },
      { immediate: true },
    );

    return () => slots.default?.();
  },
});
