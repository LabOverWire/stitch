import { afterEach, describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { Store } from '../../src/types.ts';

describe('updateIf / deleteIf (version-fenced CAS)', () => {
  const stores: Store[] = [];

  afterEach(async () => {
    while (stores.length > 0) {
      const store = stores.pop();
      if (store) await store.destroy();
    }
  });

  function open(): Store {
    const store = createStore(projectTaskConfig(), {
      persistence: { dbName: uniqueDbName() },
    });
    stores.push(store);
    return store;
  }

  it('updateIf rejects without a connected remote and neither applies nor queues the write', async () => {
    const store = open();
    await store.initialize();
    const id = await store.create('project', '', { name: 'P1' });

    await expect(store.updateIf('project', id, { name: 'P1-cas' }, 0)).rejects.toThrow();

    expect(store.read('project', id)).toMatchObject({ id, name: 'P1' });
    expect(await store.pendingMutationCount(id)).toBe(0);
  });

  it('deleteIf rejects without a connected remote and neither removes nor queues the write', async () => {
    const store = open();
    await store.initialize();
    const id = await store.create('project', '', { name: 'P1' });

    await expect(store.deleteIf('project', id, 0)).rejects.toThrow();

    expect(store.read('project', id)).toMatchObject({ id, name: 'P1' });
    expect(await store.pendingMutationCount(id)).toBe(0);
  });
});
