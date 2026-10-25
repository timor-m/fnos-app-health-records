import { onBeforeUnmount, ref } from 'vue';

/** Narrow layouts and touch-first tablets use the same record overlay. */
export function useTouchRecordDetail() {
  const media = window.matchMedia('(max-width: 760px), (pointer: coarse)');
  const touch = ref(media.matches);
  const update = () => { touch.value = media.matches; };
  media.addEventListener('change', update);
  onBeforeUnmount(() => media.removeEventListener('change', update));
  return touch;
}
