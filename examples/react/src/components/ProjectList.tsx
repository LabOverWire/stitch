import { useState, type FormEvent } from 'react';
import { useStore, useRootEntityList } from '@laboverwire/stitch/react';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectList({ selectedId, onSelect }: Props) {
  const { store, initialized } = useStore();
  const { items, loading, error } = useRootEntityList(store);
  const [name, setName] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = await store.create('project', '', {
      name: trimmed,
      createdAt: Date.now(),
    });
    setName('');
    onSelect(id);
  }

  return (
    <div className="project-list">
      <h2>Projects</h2>

      <form onSubmit={handleCreate}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          disabled={!initialized}
        />
        <button type="submit" disabled={!initialized || !name.trim()}>
          Add
        </button>
      </form>

      {error ? <p className="error">{error.message}</p> : null}
      {loading && !items.length ? <p>Loading…</p> : null}

      <ul>
        {items.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={selectedId === p.id ? 'selected' : ''}
              onClick={() => onSelect(p.id)}
            >
              {(p.name as string) || '(untitled)'}
            </button>
          </li>
        ))}
      </ul>

      {!items.length && !loading ? <p className="empty">No projects yet.</p> : null}
    </div>
  );
}
