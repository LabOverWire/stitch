<script setup lang="ts">
import { ref } from 'vue';
import { StoreRoot, StitchAuth } from '@laboverwire/stitch/vue';
import { store } from './stitch.ts';
import ConnectionBanner from './components/ConnectionBanner.vue';
import ProjectList from './components/ProjectList.vue';
import ProjectView from './components/ProjectView.vue';
import OfflineQueuePanel from './components/OfflineQueuePanel.vue';

const selectedProjectId = ref<string | null>(null);

function selectProject(id: string) {
  selectedProjectId.value = id;
}
</script>

<template>
  <StoreRoot :store="store">
    <StitchAuth :store="store" user-id="demo-user" :authenticated="true">
      <div class="app">
        <header>
          <h1>Stitch · Vue example</h1>
          <ConnectionBanner />
        </header>

        <main>
          <aside>
            <ProjectList :selected-id="selectedProjectId" @select="selectProject" />
          </aside>

          <section>
            <ProjectView v-if="selectedProjectId" :project-id="selectedProjectId" />
            <p v-else class="empty">Select or create a project to start.</p>
          </section>
        </main>

        <OfflineQueuePanel />
      </div>
    </StitchAuth>
  </StoreRoot>
</template>
