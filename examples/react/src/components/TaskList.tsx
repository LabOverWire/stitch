import { useState, type FormEvent } from 'react';
import { useStore, useEntitySnapshot } from '@laboverwire/stitch/react';

interface Props {
  projectId: string;
}

export function TaskList({ projectId }: Props) {
  const { store, initialized } = useStore();
  const tasks = useEntitySnapshot(store, projectId, 'task');
  const [title, setTitle] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    await store.create('task', projectId, {
      projectId,
      title: trimmed,
      done: false,
      createdAt: Date.now(),
    });
    setTitle('');
  }

  async function handleToggle(id: string, done: boolean) {
    await store.update('task', id, { done: !done });
  }

  async function handleDelete(id: string) {
    await store.delete('task', id);
  }

  const sorted = [...tasks].sort((a, b) => {
    return (a.createdAt as number) - (b.createdAt as number);
  });

  return (
    <div className="task-list">
      <form onSubmit={handleCreate}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task title"
          disabled={!initialized}
        />
        <button type="submit" disabled={!initialized || !title.trim()}>
          Add task
        </button>
      </form>

      <ul>
        {sorted.map((t) => {
          const id = t.id as string;
          const done = Boolean(t.done);
          return (
            <li key={id} className={done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() => handleToggle(id, done)}
                />
                <span>{t.title as string}</span>
              </label>
              <button type="button" onClick={() => handleDelete(id)}>
                Delete
              </button>
            </li>
          );
        })}
      </ul>

      {!sorted.length ? <p className="empty">No tasks yet.</p> : null}
    </div>
  );
}
