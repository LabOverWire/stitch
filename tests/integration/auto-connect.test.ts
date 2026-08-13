import { afterEach, describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { RemoteConfig, Store } from '../../src/types.ts';

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

  it('autoConnect:false skips the startup connect and stays offline', async () => {
    const store = open({ url: 'ws://127.0.0.1:1', autoConnect: false });
    await store.initialize();

    expect(store.connectionStatus).toBe('offline');
    expect(store.hasRemote).toBe(true);
  });

  it('default (autoConnect omitted) attempts the connect on initialize', async () => {
    const store = open({ url: 'ws://127.0.0.1:1' });
    await store.initialize();

    expect(store.connectionStatus).not.toBe('offline');
    expect(store.hasRemote).toBe(true);
  });
});
