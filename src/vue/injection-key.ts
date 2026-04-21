import type { InjectionKey } from 'vue';
import type { ConnectionStatus, Store } from '../types.ts';

export interface StitchContext {
  store: Store;
  initialized: boolean;
  connectionStatus: ConnectionStatus;
  error: Error | null;
}

export const STITCH_KEY: InjectionKey<StitchContext> = Symbol('stitch');
