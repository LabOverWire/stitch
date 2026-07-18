import { afterEach, describe, it, expect, vi } from 'vitest';
import { Component, type ReactNode } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { createStore } from '../../src/store.ts';
import { StoreProvider } from '../../src/react/provider.tsx';
import { useScopedEntities } from '../../src/react/hooks/useScopedEntities.ts';
import { useEntitySnapshot } from '../../src/react/hooks/useEntitySnapshot.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';
import type { Store } from '../../src/types.ts';

class ErrorBoundary extends Component<
  { onError: (error: Error) => void; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

function ScopedList({ store, scopeId }: { store: Store; scopeId: string }) {
  const { data } = useScopedEntities(store, scopeId, 'task');
  return <div data-testid="scoped-count">{data.length}</div>;
}

function SnapshotList({ store, scopeId }: { store: Store; scopeId: string }) {
  const rows = useEntitySnapshot(store, scopeId, 'task');
  return <div data-testid="snapshot-count">{rows.length}</div>;
}

function isNotInitialized(value: unknown): boolean {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : String((value as { message?: string })?.message ?? value);
  return message.toLowerCase().includes('not initialized');
}

/**
 * Capture every channel React can surface an effect/subscription error through:
 * an error boundary, window 'error'/'unhandledrejection', and console.error.
 */
function captureAllErrors() {
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
  return {
    errors,
    boundary(e: Error) {
      errors.push(e);
    },
    sawNotInitialized() {
      return errors.some(isNotInitialized);
    },
    restore() {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onRejection);
      consoleSpy.mockRestore();
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('React hooks vs store.initialize() ordering', () => {
  it('useScopedEntities mounted before initialize() does not throw', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const cap = captureAllErrors();

    render(
      <StoreProvider store={store}>
        <ErrorBoundary onError={cap.boundary}>
          <ScopedList store={store} scopeId="p1" />
        </ErrorBoundary>
      </StoreProvider>
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    cap.restore();
    store.destroy();

    expect(cap.sawNotInitialized()).toBe(false);
    expect(store.ready).toBe(true);
  });

  it('useEntitySnapshot mounted before initialize() does not throw', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const cap = captureAllErrors();

    render(
      <StoreProvider store={store}>
        <ErrorBoundary onError={cap.boundary}>
          <SnapshotList store={store} scopeId="p1" />
        </ErrorBoundary>
      </StoreProvider>
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    cap.restore();
    store.destroy();

    expect(cap.sawNotInitialized()).toBe(false);
    expect(store.ready).toBe(true);
  });

  it('a hook subscribed before init reactively receives data after init + scope load', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const cap = captureAllErrors();

    const view = render(
      <StoreProvider store={store}>
        <ErrorBoundary onError={cap.boundary}>
          <ScopedList store={store} scopeId="p1" />
        </ErrorBoundary>
      </StoreProvider>
    );

    await waitFor(() => expect(store.ready).toBe(true));
    expect(view.getByTestId('scoped-count').textContent).toBe('0');

    await store.create('project', '', { id: 'p1', name: 'P1' });
    await store.create('task', 'p1', { projectId: 'p1', title: 'T1', done: false });
    await store.replaceScope('p1');

    await waitFor(() => expect(view.getByTestId('scoped-count').textContent).toBe('1'));

    cap.restore();
    store.destroy();

    expect(cap.sawNotInitialized()).toBe(false);
  });

  it('CONTROL: a pre-initialized store mounts both hooks with no error', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    await store.initialize();
    const id = await store.create('project', '', { name: 'P1' });
    await store.create('task', id, { projectId: id, title: 'T1', done: false });
    await store.replaceScope(id);

    const cap = captureAllErrors();

    const view = render(
      <StoreProvider store={store}>
        <ErrorBoundary onError={cap.boundary}>
          <ScopedList store={store} scopeId={id} />
          <SnapshotList store={store} scopeId={id} />
        </ErrorBoundary>
      </StoreProvider>
    );

    await waitFor(() => expect(view.getByTestId('scoped-count').textContent).toBe('1'));

    cap.restore();
    store.destroy();

    expect(cap.sawNotInitialized()).toBe(false);
    expect(view.getByTestId('snapshot-count').textContent).toBe('1');
  });
});
