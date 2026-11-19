<script setup lang="ts">
import type { HealthCategory } from '../../../shared/health-categories';
import { healthCategoryImages } from '../utils/health-record-presentation';

withDefaults(defineProps<{ category: HealthCategory; size?: number; label?: string }>(), { size: 24, label: '' });
</script>

<template>
  <img class="health-category-icon" :data-health-category="category" :src="healthCategoryImages[category]"
    :width="size" :height="size" :alt="label" :aria-hidden="label ? undefined : true" draggable="false" />
</template>

<style scoped>
.health-category-icon { display: inline-block; flex-shrink: 0; object-fit: contain; vertical-align: middle; }
</style>
