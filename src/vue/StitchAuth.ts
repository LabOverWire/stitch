import { defineComponent, watch } from 'vue';
import type { PropType } from 'vue';
import type { Store } from '../types.ts';

/**
 * Binds authentication-related state to the store. Nest inside a {@link StoreRoot}.
 * Controls `setAuthenticatedUser`, session-invalid + reconnect-validator handlers, and
 * tears down the store via `resetForLogout()` when `authenticated` transitions to false.
 */
export const StitchAuth = defineComponent({
  name: 'StitchAuth',

  props: {
    store: { type: Object as PropType<Store>, required: true },
    userId: { type: String, default: undefined },
    authenticated: { type: Boolean, default: true },
    onSessionInvalid: { type: Function as PropType<() => void>, default: undefined },
    onReconnectValidate: { type: Function as PropType<() => Promise<void>>, default: undefined },
  },

  setup(props, { slots }) {
    watch(
      () =>
        [
          props.store,
          props.authenticated,
          props.userId,
          props.onSessionInvalid,
          props.onReconnectValidate,
        ] as const,
      ([store, authenticated, userId, sessionHandler, reconnectValidator]) => {
        if (!authenticated) {
          store.disconnect();
          store.resetForLogout();
          return;
        }
        if (userId) store.setAuthenticatedUser(userId);
        if (sessionHandler) store.setSessionInvalidHandler(sessionHandler);
        if (reconnectValidator) store.setReconnectValidator(reconnectValidator);
      },
      { immediate: true }
    );

    return () => slots.default?.();
  },
});
