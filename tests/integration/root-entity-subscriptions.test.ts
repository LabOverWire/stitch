import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('root entity: subscriptions and snapshot', () => {
  it('subscribeToEntity fires for root entity create/update/delete', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    const events: string[] = [];
    const unsubscribe = store.subscribeToEntity('project', () => {
      events.push('notify');
    });

    const id = await store.create('project', '', { name: 'P1' });
    await store.update('project', id, { name: 'P1-updated' });
    await store.delete('project', id);

    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(3));

    unsubscribe();
    store.destroy();
  });

  it('getSnapshot for root entity returns the record keyed by scopeId without pollution', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    const id = await store.create('project', '', { name: 'P1' });
    await store.replaceScope(id);

    const snapshot = store.getSnapshot('project', id);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ id, name: 'P1' });
    expect(snapshot[0].projectId).toBeUndefined();

    const read = store.read('project', id);
    expect(read).toMatchObject({ id, name: 'P1' });
    expect(read?.projectId).toBeUndefined();

    store.destroy();
  });

  it('subscribeToEntity fires when replaceScope loads the root into memory', async () => {
    const dbName = uniqueDbName();
    {
      const seed = createStore(projectTaskConfig(), { persistence: { dbName } });
      await seed.initialize();
      await seed.create('project', '', { name: 'Persisted project' });
      seed.destroy();
    }

    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();
    const [root] = await store.listRootEntities();
    const scopeId = root.id as string;

    const events: Array<{ name: string | undefined; op: string }> = [];
    const unsubscribe = store.subscribeToEntity('project', (data, op) => {
      events.push({ name: data?.name as string | undefined, op });
    });

    await store.replaceScope(scopeId);

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(store.read('project', scopeId)).toMatchObject({ name: 'Persisted project' });

    unsubscribe();
    store.destroy();
  });

  it('subscribeToScope for root fires after openScope populates memory from persistence', async () => {
    const dbName = uniqueDbName();
    {
      const seed = createStore(projectTaskConfig(), { persistence: { dbName } });
      await seed.initialize();
      await seed.create('project', '', { name: 'P1' });
      seed.destroy();
    }

    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();
    const [root] = await store.listRootEntities();
    const scopeId = root.id as string;

    let fires = 0;
    const unsubscribe = store.subscribeToScope(scopeId, 'project', () => {
      fires += 1;
    });

    await store.replaceScope(scopeId);

    await vi.waitFor(() => expect(fires).toBeGreaterThan(0));
    const snap = store.getSnapshot('project', scopeId);
    expect(snap).toHaveLength(1);

    unsubscribe();
    store.destroy();
  });
});
