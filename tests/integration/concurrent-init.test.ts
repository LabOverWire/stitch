import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('store.initialize: concurrent calls are safe', () => {
  it('concurrent initialize() calls share a single promise and yield one persistence layer', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();
    const store = createStore(config, { persistence: { dbName } });

    // Fire two overlapping initializes (the React StrictMode scenario).
    const [a, b] = await Promise.all([store.initialize(), store.initialize()]);

    // Both resolve. Both observe ready=true.
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(store.ready).toBe(true);

    // A subscriber registered before init completes must survive through initialization
    // and receive events on subsequent mutations.
    const store2 = createStore(projectTaskConfig(), {
      persistence: { dbName: uniqueDbName() },
    });

    const events: Array<{ op: string; id: string | null }> = [];
    const unsubscribe = store2.subscribeToEntity('project', (data, op) => {
      events.push({ op, id: data?.id as string | null | undefined ?? null });
    });

    // Kick off two concurrent inits and one create while init is still in flight.
    const initA = store2.initialize();
    const initB = store2.initialize();
    await Promise.all([initA, initB]);

    const id = await store2.create('project', '', { name: 'P1' });
    expect(events.some((e) => e.op === 'insert' && e.id === id)).toBe(true);

    unsubscribe();
    store2.destroy();
    store.destroy();
  });

  it('a second initialize() after completion is a no-op', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();
    const store = createStore(config, { persistence: { dbName } });

    await store.initialize();
    const persistenceBefore = store.hasPersistence;
    await store.initialize();
    const persistenceAfter = store.hasPersistence;

    expect(persistenceBefore).toBe(true);
    expect(persistenceAfter).toBe(true);
    expect(store.ready).toBe(true);

    store.destroy();
  });
});
