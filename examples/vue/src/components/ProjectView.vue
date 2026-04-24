<script setup lang="ts">
import { computed, watch } from 'vue';
import { useStore, useSyncScope, useEntitySnapshotAsMap } from '@laboverwire/stitch/vue';
import TaskList from './TaskList.vue';

const props = defineProps<{ projectId: string }>();
const ctx = useStore();
const { syncing, syncError, openScope } = useSyncScope(ctx.store, () => props.projectId);
const syncErrorMessage = computed(() => syncError.value?.message ?? '');

const projects = useEntitySnapshotAsMap(ctx.store, () => props.projectId, 'project');

const heading = computed(() => {
  const p = projects.value[props.projectId];
  return (p?.name as string) ?? props.projectId;
});

watch(
  () => [ctx.initialized, props.projectId] as const,
  ([ready, pid]) => {
    if (!ready || !pid) return;
    void openScope();
  },
  { immediate: true }
);
</script>

<template>
  <div class="project-view">
    <h2>{{ heading }}</h2>

    <p v-if="syncing">Opening scope…</p>
    <p v-if="syncError" class="error">{{ syncErrorMessage }}</p>

    <TaskList :project-id="projectId" />
  </div>
</template>
