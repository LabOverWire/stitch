import { useEffect, useState } from 'react';
import { useStore } from '@laboverwire/stitch/react';

interface PendingRow {
  id: string;
  op: string;
  entity: string;
  entityId: string;
  scopeId: string;
  createdAt: number;
}

export function OfflineQueuePanel() {
  const { store, initialized } = useStore();
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!initialized || !store.hasRemote) return;

    let cancelled = false;

    async function refresh() {
      try {
        const list = await store.list('pending_sync');
        if (!cancelled) {
          setRows(list as unknown as PendingRow[]);
        }
      } catch {
        // ignore
      }
    }

    void refresh();
    const id = setInterval(refresh, 1000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [initialized, store]);

  if (!store.hasRemote) {
    return (
      <footer className="queue-panel queue-panel--hint">
        Offline queue inactive. Set <code>VITE_STITCH_SERVER_URL</code> to enable remote sync.
      </footer>
    );
  }

  return (
    <footer className="queue-panel">
      <button type="button" onClick={() => setOpen((v) => !v)}>
        Offline queue ({rows.length}) {open ? '▾' : '▸'}
      </button>
      {open ? (
        rows.length ? (
          <table>
            <thead>
              <tr>
                <th>op</th>
                <th>entity</th>
                <th>entityId</th>
                <th>scopeId</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.op}</td>
                  <td>{r.entity}</td>
                  <td>{r.entityId}</td>
                  <td>{r.scopeId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No pending mutations.</p>
        )
      ) : null}
    </footer>
  );
}
