<script setup lang="ts">
import { computed } from 'vue';
import { useStore, useConnectionStatus } from '@laboverwire/stitch/vue';
import { hasRemoteConfigured } from '../stitch.ts';

const ctx = useStore();
const status = useConnectionStatus(ctx.store);

const message = computed(() =>
  hasRemoteConfigured
    ? `Remote: ${status.value}`
    : 'Remote: disabled (set VITE_STITCH_SERVER_URL to enable)'
);
</script>

<template>
  <div :class="['banner', `banner--${status}`]">
    <span>{{ ctx.initialized ? '✓ store ready' : '… initializing' }}</span>
    <span>{{ message }}</span>
    <span v-if="ctx.error" class="banner__error">{{ ctx.error.message }}</span>
  </div>
</template>
