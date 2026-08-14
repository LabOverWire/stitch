import { afterEach, describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { RemoteConfig, Store } from '../../src/types.ts';

const UNROUTABLE = 'ws://127.0.0.1:49871';

describe('remote.autoConnect', () => {
  const stores: Store[] = [];

  afterEach(async () => {
    while (stores.length > 0) {
      const store = stores.pop();
      if (store) await store.destroy();
    }
  });

  function open(remote: RemoteConfig): Store {
    const store = createStore(projectTaskConfig(), {
      persistence: { dbName: uniqueDbName() },
      remote,
    });
    stores.push(store);
    return store;
  }

  it('autoConnect:false does not start a connection on initialize', async () => {
    const store = open({ url: UNROUTABLE, autoConnect: false });
    await store.initialize();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(store.connectionStatus).not.toBe('connecting');
    expect(store.connectionStatus).not.toBe('connected');
    expect(store.isReconnecting).toBe(false);
    expect(store.hasRemote).toBe(true);
  });

  it('default (autoConnect omitted) starts the connection on initialize', async () => {
    const store = open({ url: UNROUTABLE });
    await store.initialize();

    await vi.waitFor(() => expect(store.connectionStatus).toBe('connecting'));
    expect(store.hasRemote).toBe(true);
  });
});
