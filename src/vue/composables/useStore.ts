import { inject } from 'vue';
import { STITCH_KEY } from '../injection-key.ts';
import type { StitchContext } from '../injection-key.ts';

export function useStore(): StitchContext {
  const ctx = inject(STITCH_KEY);
  if (!ctx) throw new Error('useStore must be used within a StoreRoot');
  return ctx;
}
