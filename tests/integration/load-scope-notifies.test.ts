import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('memory-store.loadScope: subscriber notification', () => {
  it('notifies subscribeToScope listeners with records loaded from persistence', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();

    {
      const seed = createStore(config, { persistence: { dbName } });
      await seed.initialize();
      const projectId = await seed.create('project', '', { name: 'P1' });
      await seed.create('task', projectId, { projectId, title: 'T1', done: false });
      await seed.create('task', projectId, { projectId, title: 'T2', done: true });
      seed.destroy();
    }

    const store = createStore(config, { persistence: { dbName } });
    await store.initialize();

    const roots = await store.listRootEntities();
    expect(roots).toHaveLength(1);
    const projectId = roots[0].id as string;

    let callCount = 0;
    const unsubscribe = store.subscribeToScope(projectId, 'task', () => {
      callCount += 1;
    });

    await store.replaceScope(projectId);

    expect(callCount).toBeGreaterThan(0);

    const snapshot = store.getSnapshot('task', projectId);
    expect(snapshot).toHaveLength(2);

    unsubscribe();
    store.destroy();
  });

  it('getSnapshot reflects loaded data after openScope resolves', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();

    {
      const seed = createStore(config, { persistence: { dbName } });
      await seed.initialize();
      const projectId = await seed.create('project', '', { name: 'P1' });
      await seed.create('task', projectId, { projectId, title: 'T1', done: false });
      seed.destroy();
    }

    const store = createStore(config, { persistence: { dbName } });
    await store.initialize();
    const [root] = await store.listRootEntities();
    await store.replaceScope(root.id as string);

    const tasks = store.getSnapshot('task', root.id as string);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('T1');

    store.destroy();
  });
});
