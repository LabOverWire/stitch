<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { useStore } from '@laboverwire/stitch/vue';
import { hasRemoteConfigured } from '../stitch.ts';

interface PendingRow {
  id: string;
  op: string;
  entity: string;
  entityId: string;
  scopeId: string;
  createdAt: number;
}

const ctx = useStore();
const rows = ref<PendingRow[]>([]);
const open = ref(false);
let timer: number | null = null;

async function refresh() {
  try {
    const list = await ctx.store.list('pending_sync');
    rows.value = list as unknown as PendingRow[];
  } catch {
    // ignore
  }
}

watch(
  () => ctx.initialized,
  (ready) => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!ready || !hasRemoteConfigured) return;
    void refresh();
    timer = window.setInterval(refresh, 1000);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <footer v-if="!hasRemoteConfigured" class="queue-panel queue-panel--hint">
    Offline queue inactive. Set <code>VITE_STITCH_SERVER_URL</code> to enable remote sync.
  </footer>
  <footer v-else class="queue-panel">
    <button type="button" @click="open = !open">
      Offline queue ({{ rows.length }}) {{ open ? '▾' : '▸' }}
    </button>
    <template v-if="open">
      <table v-if="rows.length">
        <thead>
          <tr>
            <th>op</th>
            <th>entity</th>
            <th>entityId</th>
            <th>scopeId</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ r.op }}</td>
            <td>{{ r.entity }}</td>
            <td>{{ r.entityId }}</td>
            <td>{{ r.scopeId }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">No pending mutations.</p>
    </template>
  </footer>
</template>
