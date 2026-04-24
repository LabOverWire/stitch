import { useStore, useConnectionStatus } from '@laboverwire/stitch/react';
import { hasRemoteConfigured } from '../stitch.ts';

export function ConnectionBanner() {
  const { store, initialized, error } = useStore();
  const status = useConnectionStatus(store);

  const message = hasRemoteConfigured
    ? `Remote: ${status}`
    : 'Remote: disabled (set VITE_STITCH_SERVER_URL to enable)';

  return (
    <div className={`banner banner--${status}`}>
      <span>{initialized ? '✓ store ready' : '… initializing'}</span>
      <span>{message}</span>
      {error ? <span className="banner__error">{error.message}</span> : null}
    </div>
  );
}
