import { useEffect, useSyncExternalStore } from 'react';
import { useStore, useSyncScope } from '@laboverwire/stitch/react';
import type { Store } from '@laboverwire/stitch';
import { TaskList } from './TaskList.tsx';

interface Props {
  projectId: string;
}

function useProjectName(store: Store, projectId: string): string | null {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribeToEntity('project', onStoreChange),
    () => {
      const project = store.read('project', projectId);
      if (!project) return null;
      return (project.name as string) ?? null;
    }
  );
}

export function ProjectView({ projectId }: Props) {
  const { store, initialized } = useStore();
  const { syncing, syncError, openScope } = useSyncScope(store, projectId);
  const projectName = useProjectName(store, projectId);

  useEffect(() => {
    if (!initialized) return;
    void openScope();
  }, [initialized, openScope]);

  return (
    <div className="project-view">
      <h2>{projectName ?? projectId}</h2>

      {syncing ? <p>Opening scope…</p> : null}
      {syncError ? <p className="error">{syncError.message}</p> : null}

      <TaskList projectId={projectId} />
    </div>
  );
}
