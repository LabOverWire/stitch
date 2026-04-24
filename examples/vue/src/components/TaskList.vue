<script setup lang="ts">
import { ref, computed } from 'vue';
import { useStore, useEntitySnapshot } from '@laboverwire/stitch/vue';

const props = defineProps<{ projectId: string }>();
const ctx = useStore();
const tasks = useEntitySnapshot(ctx.store, () => props.projectId, 'task');

const title = ref('');

const sorted = computed(() =>
  [...tasks.value].sort((a, b) => (a.createdAt as number) - (b.createdAt as number))
);

async function handleCreate() {
  const trimmed = title.value.trim();
  if (!trimmed) return;
  await ctx.store.create('task', props.projectId, {
    projectId: props.projectId,
    title: trimmed,
    done: false,
    createdAt: Date.now(),
  });
  title.value = '';
}

async function handleToggle(id: string, done: boolean) {
  await ctx.store.update('task', id, { done: !done });
}

async function handleDelete(id: string) {
  await ctx.store.delete('task', id);
}
</script>

<template>
  <div class="task-list">
    <form @submit.prevent="handleCreate">
      <input
        v-model="title"
        type="text"
        placeholder="New task title"
        :disabled="!ctx.initialized"
      />
      <button type="submit" :disabled="!ctx.initialized || !title.trim()">Add task</button>
    </form>

    <ul>
      <li v-for="t in sorted" :key="t.id as string" :class="t.done ? 'done' : ''">
        <label>
          <input
            type="checkbox"
            :checked="Boolean(t.done)"
            @change="handleToggle(t.id as string, Boolean(t.done))"
          />
          <span>{{ t.title }}</span>
        </label>
        <button type="button" @click="handleDelete(t.id as string)">Delete</button>
      </li>
    </ul>

    <p v-if="!sorted.length" class="empty">No tasks yet.</p>
  </div>
</template>
