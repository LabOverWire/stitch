import { describe, it, expect, expectTypeOf } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { Store } from '../../src/types.ts';

interface Project {
  id: string;
  name: string;
  createdAt: number;
}

interface Task {
  id: string;
  projectId: string;
  title: string;
  done: boolean;
  createdAt: number;
}

type Schema = { project: Project; task: Task };

describe('generic Schema typing', () => {
  it('read returns the declared entity type or null', async () => {
    const dbName = uniqueDbName();
    const store = createStore<Schema>(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    const projectId = await store.create('project', '', {
      name: 'P1',
      createdAt: Date.now(),
    });
    const project = store.read('project', projectId);

    expectTypeOf(project).toEqualTypeOf<Project | null>();
    expect(project?.name).toBe('P1');

    store.destroy();
  });

  it('getSnapshot returns an array of the declared entity type', async () => {
    const dbName = uniqueDbName();
    const store = createStore<Schema>(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    const projectId = await store.create('project', '', { name: 'P1', createdAt: Date.now() });
    await store.create('task', projectId, {
      projectId,
      title: 'T1',
      done: false,
      createdAt: Date.now(),
    });
    await store.replaceScope(projectId);

    const tasks = store.getSnapshot('task', projectId);
    expectTypeOf(tasks).toEqualTypeOf<Task[]>();
    expect(tasks[0].title).toBe('T1');

    store.destroy();
  });

  it('without a schema, falls back to Record<string, unknown>', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });
    await store.initialize();

    expectTypeOf(store).toExtend<Store>();
    const projectId = await store.create('project', '', { name: 'P1' });
    const project = store.read('project', projectId);
    expectTypeOf(project).toEqualTypeOf<Record<string, unknown> | null>();

    store.destroy();
  });
});
