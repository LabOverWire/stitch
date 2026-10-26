import { afterEach, describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { createStore } from '../../src/store.ts';
import { StoreProvider } from '../../src/react/provider.tsx';
import { useSyncScope } from '../../src/react/hooks/useSyncScope.ts';
import { useScopedEntities } from '../../src/react/hooks/useScopedEntities.ts';
import { projectTaskConfig, uniqueDbName } from '../helpers/fixtures.ts';

afterEach(() => {
  cleanup();
});

describe('useSyncScope: a scope opened empty converges once the engine backfills it', () => {
  it('fills after an empty open with no reload, and the hook never re-opens', async () => {
    const store = createStore(projectTaskConfig(), { persistence: { dbName: uniqueDbName() } });
    const projectId = 'p1';
    const hook: { open?: () => Promise<void> } = {};

    function Harness() {
      const { openScope } = useSyncScope(store, projectId);
      const { data } = useScopedEntities(store, projectId, 'task');
      useEffect(() => {
        hook.open = openScope;
      }, [openScope]);
      return <div data-testid="scoped-count">{data.length}</div>;
    }

    const view = render(
      <StoreProvider store={store}>
        <Harness />
      </StoreProvider>
    );

    await waitFor(() => expect(store.ready).toBe(true));

    await hook.open?.();
    expect(view.getByTestId('scoped-count').textContent).toBe('0');

    await store.create('project', '', { id: projectId, name: 'P1' });
    await store.create('task', projectId, { projectId, title: 'T1', done: false });
    await store.replaceScope(projectId);

    await waitFor(() => expect(view.getByTestId('scoped-count').textContent).toBe('1'));

    const reopen = vi.spyOn(store, 'replaceScope');
    await hook.open?.();
    expect(reopen).not.toHaveBeenCalled();
    expect(view.getByTestId('scoped-count').textContent).toBe('1');
    reopen.mockRestore();

    await store.destroy();
  });
});
