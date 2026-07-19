import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('smoke: core store operations', () => {
  it('memory-only store supports create/read/update/delete', async () => {
    const config = projectTaskConfig({
      entities: {
        project: {
          fields: [
            { name: 'id', type: 'string' },
            { name: 'name', type: 'string' },
          ],
        },
        task: {
          fields: [
            { name: 'id', type: 'string' },
            { name: 'projectId', type: 'string' },
            { name: 'title', type: 'string' },
          ],
          foreignKeys: [{ field: 'projectId', references: 'project', onDelete: 'cascade' }],
        },
      },
    });
    const store = createStore(config);
    await store.initialize();

    const projectId = await store.create('project', '', { name: 'P1' });
    expect(store.read('project', projectId)).toMatchObject({ id: projectId, name: 'P1' });

    const taskId = await store.create('task', projectId, { projectId, title: 'T1' });
    expect(store.read('task', taskId)).toMatchObject({ id: taskId, title: 'T1' });

    await store.update('task', taskId, { title: 'T1-updated' });
    expect(store.read('task', taskId)).toMatchObject({ title: 'T1-updated' });

    await store.delete('task', taskId);
    expect(store.read('task', taskId)).toBeNull();

    store.destroy();
  });

  it('persistent store survives destroy + rehydrate', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();

    {
      const store = createStore(config, { persistence: { dbName } });
      await store.initialize();
      await store.create('project', '', { name: 'P1' });
      store.destroy();
    }

    const store = createStore(config, { persistence: { dbName } });
    await store.initialize();
    const roots = await store.listRootEntities();
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('P1');

    store.destroy();
  });

  it('subscribeToEntity fires on create/update/delete', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    const events: string[] = [];
    const unsubscribe = store.subscribeToEntity('project', () => {
      events.push('notify');
    });

    await store.create('project', '', { name: 'P1' });
    const [root] = await store.listRootEntities();
    await store.update('project', root.id as string, { name: 'P1-updated' });
    await store.delete('project', root.id as string);

    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(3));

    unsubscribe();
    store.destroy();
  });
});
