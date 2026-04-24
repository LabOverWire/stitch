import { createStore } from '@laboverwire/stitch';
import type { StoreConfig } from '@laboverwire/stitch';

interface Project {
  id: string;
  name: string;
  createdAt: number;
}

interface Task {
  id: string;
  projectId: string;
  title: string;
  done: boolean;
  createdAt: number;
}

type Schema = { project: Project; task: Task };

const DB_NAME = 'stitch-vanilla-example';

const config: StoreConfig = {
  entities: {
    project: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'createdAt', type: 'number' },
      ],
    },
    task: {
      fields: [
        { name: 'id', type: 'string' },
        { name: 'projectId', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'done', type: 'boolean', default: false },
        { name: 'createdAt', type: 'number' },
      ],
      foreignKeys: [{ field: 'projectId', references: 'project', onDelete: 'cascade' }],
      indexes: ['projectId'],
    },
  },
  scope: { rootEntity: 'project', childEntities: ['task'], scopeField: 'projectId' },
};

const store = createStore<Schema>(config, { persistence: { dbName: DB_NAME } });

const $status = document.getElementById('status') as HTMLParagraphElement;
const $projectForm = document.getElementById('project-form') as HTMLFormElement;
const $projectName = document.getElementById('project-name') as HTMLInputElement;
const $projectList = document.getElementById('project-list') as HTMLUListElement;
const $scopeTitle = document.getElementById('scope-title') as HTMLHeadingElement;
const $taskForm = document.getElementById('task-form') as HTMLFormElement;
const $taskTitle = document.getElementById('task-title') as HTMLInputElement;
const $taskList = document.getElementById('task-list') as HTMLUListElement;

let selectedProjectId: string | null = null;

async function renderProjects(): Promise<void> {
  const projects = (await store.listRootEntities([
    { field: 'createdAt', direction: 'asc' },
  ])) as unknown as Project[];
  $projectList.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.name;
    btn.onclick = () => selectProject(p.id);
    if (p.id === selectedProjectId) btn.style.fontWeight = 'bold';
    li.append(btn);
    $projectList.append(li);
  }
}

function renderTasks(): void {
  if (!selectedProjectId) return;
  const tasks = [...store.getSnapshot('task', selectedProjectId)];
  tasks.sort((a, b) => a.createdAt - b.createdAt);
  $taskList.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    if (t.done) li.classList.add('done');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = t.done;
    check.onchange = () => store.update('task', t.id, { done: !t.done });
    const span = document.createElement('span');
    span.textContent = t.title;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.onclick = () => store.delete('task', t.id);
    li.append(check, span, del);
    $taskList.append(li);
  }
}

let taskUnsubscribe: (() => void) | null = null;

async function selectProject(id: string): Promise<void> {
  selectedProjectId = id;
  await store.replaceScope(id);
  taskUnsubscribe?.();
  taskUnsubscribe = store.subscribeToScope(id, 'task', renderTasks);
  $scopeTitle.hidden = false;
  $taskForm.hidden = false;
  renderTasks();
  await renderProjects();
}

$projectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $projectName.value.trim();
  if (!name) return;
  const id = await store.create('project', '', { name, createdAt: Date.now() });
  $projectName.value = '';
  await selectProject(id);
});

$taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedProjectId) return;
  const title = $taskTitle.value.trim();
  if (!title) return;
  await store.create('task', selectedProjectId, {
    projectId: selectedProjectId,
    title,
    done: false,
    createdAt: Date.now(),
  });
  $taskTitle.value = '';
});

store.subscribeToEntity('project', () => {
  void renderProjects();
});

async function main(): Promise<void> {
  await store.initialize();
  $status.textContent = `✓ store ready (${store.hasPersistence ? 'memory + IndexedDB' : 'memory only'})`;
  await renderProjects();
}

void main();
