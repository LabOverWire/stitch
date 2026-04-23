import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('persistence-layer: entity config with `indexes`', () => {
  it('initializes without crashing on a persistent backend', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();

    const store = createStore(config, { persistence: { dbName } });

    await expect(store.initialize()).resolves.not.toThrow();
    expect(store.ready).toBe(true);
    expect(store.hasPersistence).toBe(true);

    store.destroy();
  });

  it('supports indexed child entity queries via listRootEntities and list', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();

    const store = createStore(config, { persistence: { dbName } });
    await store.initialize();

    const projectId = await store.create('project', '', { name: 'P1' });
    await store.create('task', projectId, { projectId, title: 'T1', done: false });
    await store.create('task', projectId, { projectId, title: 'T2', done: true });

    const roots = await store.listRootEntities();
    expect(roots).toHaveLength(1);

    const tasks = await store.list('task', { scopeId: projectId });
    expect(tasks).toHaveLength(2);

    store.destroy();
  });
});
