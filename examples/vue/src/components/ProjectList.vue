<script setup lang="ts">
import { ref, computed } from 'vue';
import { useStore, useRootEntityList } from '@laboverwire/stitch/vue';

defineProps<{ selectedId: string | null }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();

const ctx = useStore();
const { items: itemsRef, loading: loadingRef, error: errorRef } = useRootEntityList(ctx.store);
const items = computed(() => itemsRef.value);
const loading = computed(() => loadingRef.value);
const errorMessage = computed(() => errorRef.value?.message ?? null);
const name = ref('');

async function handleCreate() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  const id = await ctx.store.create('project', '', {
    name: trimmed,
    createdAt: Date.now(),
  });
  name.value = '';
  emit('select', id);
}
</script>

<template>
  <div class="project-list">
    <h2>Projects</h2>

    <form @submit.prevent="handleCreate">
      <input
        v-model="name"
        type="text"
        placeholder="New project name"
        :disabled="!ctx.initialized"
      />
      <button type="submit" :disabled="!ctx.initialized || !name.trim()">Add</button>
    </form>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    <p v-if="loading && !items.length">Loading…</p>

    <ul>
      <li v-for="p in items" :key="p.id">
        <button
          type="button"
          :class="selectedId === p.id ? 'selected' : ''"
          @click="emit('select', p.id)"
        >
          {{ (p.name as string) || '(untitled)' }}
        </button>
      </li>
    </ul>

    <p v-if="!items.length && !loading" class="empty">No projects yet.</p>
  </div>
</template>
