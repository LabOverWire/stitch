import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

describe('store.initialize: concurrent calls are safe', () => {
  it('concurrent initialize() calls share a single promise and yield one persistence layer', async () => {
    const dbName = uniqueDbName();
    const config = projectTaskConfig();
    const store = createStore(config, { persistence: { dbName } });

    const [a, b] = await Promise.all([store.initialize(), store.initialize()]);

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(store.ready).toBe(true);

    const store2 = createStore(projectTaskConfig(), {
      persistence: { dbName: uniqueDbName() },
    });

    const initA = store2.initialize();
    const initB = store2.initialize();
    await Promise.all([initA, initB]);

    const events: Array<{ op: string; id: string | null }> = [];
    const unsubscribe = store2.subscribeToEntity('project', (data, op) => {
      events.push({ op, id: (data?.id as string | null | undefined) ?? null });
    });

    const id = await store2.create('project', '', { name: 'P1' });
    await vi.waitFor(() => expect(events.some((e) => e.op === 'insert' && e.id === id)).toBe(true));

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

  it('unsubscribing after init cancels the subscription', async () => {
    const dbName = uniqueDbName();
    const store = createStore(projectTaskConfig(), { persistence: { dbName } });

    await store.initialize();

    const events: string[] = [];
    const unsubscribe = store.subscribeToEntity('project', () => {
      events.push('fire');
    });

    await store.create('project', '', { name: 'P1' });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    const afterFirstCreate = events.length;

    unsubscribe();
    await store.create('project', '', { name: 'P2' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.length).toBe(afterFirstCreate);

    store.destroy();
  });
});
