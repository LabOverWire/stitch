import { afterEach, describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { ConnectionStatus, RemoteConfig, Store } from '../../src/types.ts';

const UNROUTABLE = 'ws://127.0.0.1:49871';

describe('subscribeToConnectionStatus', () => {
  const stores: Store[] = [];

  afterEach(async () => {
    while (stores.length > 0) {
      const store = stores.pop();
      if (store) await store.destroy();
    }
  });

  function open(remote?: RemoteConfig): Store {
    const store = createStore(projectTaskConfig(), {
      persistence: { dbName: uniqueDbName() },
      ...(remote ? { remote } : {}),
    });
    stores.push(store);
    return store;
  }

  it('delivers the current status once to a subscriber that attaches after initialize', async () => {
    const store = open();
    await store.initialize();

    const seen: ConnectionStatus[] = [];
    store.subscribeToConnectionStatus((s) => seen.push(s));

    expect(seen).toEqual([store.connectionStatus]);
  });

  it('delivers connection-status transitions to subscribers', async () => {
    const store = open({ url: UNROUTABLE });
    await store.initialize();
    await vi.waitFor(() => expect(store.connectionStatus).toBe('connecting'));

    const seen: ConnectionStatus[] = [];
    store.subscribeToConnectionStatus((s) => seen.push(s));

    await store.disconnect();

    await vi.waitFor(() => expect(seen).toContain('disconnected'));
    expect(store.connectionStatus).toBe('disconnected');
  });
});
