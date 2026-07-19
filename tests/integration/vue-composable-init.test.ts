import { afterEach, describe, it, expect, vi } from 'vitest';
import { createApp, defineComponent, h, type PropType, type VNode } from 'vue';
import { StoreRoot } from '../../src/vue/StoreRoot.ts';
import { useScopedEntities } from '../../src/vue/composables/useScopedEntities.ts';
import { useEntitySnapshot } from '../../src/vue/composables/useEntitySnapshot.ts';
import { createStore } from '../../src/store.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { Store } from '../../src/types.ts';

const ScopedList = defineComponent({
  name: 'ScopedList',
  props: {
    store: { type: Object as PropType<Store>, required: true },
    scopeId: { type: String, required: true },
  },
  setup(props) {
    const { data } = useScopedEntities(props.store, () => props.scopeId, 'task');
    return () => h('div', { 'data-testid': 'scoped-count' }, String(data.value.length));
  },
});

const SnapshotList = defineComponent({
  name: 'SnapshotList',
  props: {
    store: { type: Object as PropType<Store>, required: true },
    scopeId: { type: String, required: true },
  },
  setup(props) {
    const rows = useEntitySnapshot(props.store, () => props.scopeId, 'task');
    return () => h('div', { 'data-testid': 'snapshot-count' }, String(rows.value.length));
  },
});

function isNotInitialized(value: unknown): boolean {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : String((value as { message?: string })?.message ?? value);
  return message.toLowerCase().includes('not initialized');
}

interface Mounted {
  container: HTMLElement;
  errors: unknown[];
  sawNotInitialized(): boolean;
  teardown(): void;
}

function mountUnderStoreRoot(store: Store, child: VNode): Mounted {
  const errors: unknown[] = [];
  const onWindowError = (e: ErrorEvent) => {
    errors.push(e.error ?? e.message);
    e.preventDefault();
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    errors.push(e.reason);
    e.preventDefault();
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args[0]);
  });

  const container = document.createElement('div');
  document.body.appendChild(container);

  const app = createApp({
    render: () => h(StoreRoot, { store }, { default: () => child }),
  });
  app.config.errorHandler = (err) => errors.push(err);

  try {
    app.mount(container);
  } catch (err) {
    errors.push(err);
  }

  return {
    container,
    errors,
    sawNotInitialized: () => errors.some(isNotInitialized),
    teardown() {
      app.unmount();
      container.remove();
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onRejection);
      consoleSpy.mockRestore();
    },
  };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

describe('Vue composables vs store.initialize() ordering', () => {
  it('useScopedEntities mounted before initialize() does not throw', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const mounted = mountUnderStoreRoot(store, h(ScopedList, { store, scopeId: 'p1' }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const sawIt = mounted.sawNotInitialized();
    mounted.teardown();
    store.destroy();

    expect(sawIt).toBe(false);
    expect(store.ready).toBe(true);
  });

  it('useEntitySnapshot mounted before initialize() does not throw', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const mounted = mountUnderStoreRoot(store, h(SnapshotList, { store, scopeId: 'p1' }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const sawIt = mounted.sawNotInitialized();
    mounted.teardown();
    store.destroy();

    expect(sawIt).toBe(false);
    expect(store.ready).toBe(true);
  });

  it('CONTROL: a pre-initialized store mounts composables with no error', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    await store.initialize();
    const id = await store.create('project', '', { name: 'P1' });
    await store.create('task', id, { projectId: id, title: 'T1', done: false });
    await store.replaceScope(id);

    const mounted = mountUnderStoreRoot(store, h(SnapshotList, { store, scopeId: id }));

    await pollUntil(
      () => mounted.container.querySelector('[data-testid="snapshot-count"]')?.textContent === '1'
    );

    const sawIt = mounted.sawNotInitialized();
    const text = mounted.container.querySelector('[data-testid="snapshot-count"]')?.textContent;
    mounted.teardown();
    store.destroy();

    expect(sawIt).toBe(false);
    expect(text).toBe('1');
  });
});
