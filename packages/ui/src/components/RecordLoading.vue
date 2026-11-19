<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
withDefaults(defineProps<{ label?: string }>(), { label: '正在加载记录…' });
</script>
<template><div class="record-detail-loading" role="status"><LoaderCircle class="spin-icon" :size="18" aria-hidden="true" /><span>{{ label }}</span></div></template>
