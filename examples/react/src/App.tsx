import { useState } from 'react';
import { StoreProvider, AuthProvider } from '@laboverwire/stitch/react';
import { store } from './stitch.ts';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { ProjectList } from './components/ProjectList.tsx';
import { ProjectView } from './components/ProjectView.tsx';
import { OfflineQueuePanel } from './components/OfflineQueuePanel.tsx';

export function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  return (
    <StoreProvider store={store}>
      <AuthProvider store={store} userId="demo-user" authenticated>
        <div className="app">
        <header>
          <h1>Stitch · React example</h1>
          <ConnectionBanner />
        </header>

        <main>
          <aside>
            <ProjectList
              selectedId={selectedProjectId}
              onSelect={setSelectedProjectId}
            />
          </aside>

          <section>
            {selectedProjectId ? (
              <ProjectView projectId={selectedProjectId} />
            ) : (
              <p className="empty">Select or create a project to start.</p>
            )}
          </section>
        </main>

        <OfflineQueuePanel />
        </div>
      </AuthProvider>
    </StoreProvider>
  );
}
