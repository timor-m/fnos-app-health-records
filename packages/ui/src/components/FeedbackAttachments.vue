<script setup lang="ts">
import { FileText } from '@lucide/vue';
import { feedbackImageUrl, type FeedbackImage } from '../utils/feedback-service';
defineProps<{ attachments: FeedbackImage[] }>();
</script>

<template>
  <div class="feedback-attachments">
    <a v-for="(file, index) in attachments" :key="file.id" :href="feedbackImageUrl(file)" target="_blank" rel="noopener" :aria-label="`查看附件 ${index + 1}`">
      <span v-if="file.mimeType === 'application/pdf'" class="pdf-card"><FileText :size="28" /><strong>PDF 附件 {{ index + 1 }}</strong><span>查看 PDF</span></span>
      <img v-else :src="feedbackImageUrl(file)" :alt="`问题截图 ${index + 1}`" />
    </a>
  </div>
</template>

<style scoped>
.feedback-attachments { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
a { display: block; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; color: var(--brand-strong); text-decoration: none; }
img { width: 100%; height: 130px; object-fit: cover; display: block; }
.pdf-card { min-height: 130px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; font-size: 12px; }
</style>
