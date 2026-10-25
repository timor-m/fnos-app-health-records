import { expect, it } from 'vitest';
import { ref, isRef } from 'vue';
import { useAppContext } from '../src/composables/useAppContext';

it('preserves the live search ref for shell reading, typing and clearing', () => {
  const app=useAppContext();const model=ref('合成搜索');
  app.setTopbarSearch({key:'events',model,placeholder:'搜索记录'});
  expect(isRef(app.topbarSearch.value?.model)).toBe(true);
  expect(app.topbarSearch.value?.model.value).toBe('合成搜索');
  app.setTopbarSearchValue('复查');expect(model.value).toBe('复查');
  expect(app.topbarSearch.value?.model.value).toBe('复查');
  app.setTopbarSearchValue('');expect(app.topbarSearch.value?.model.value).toBe('');
  app.clearTopbarSearch('events');expect(app.topbarSearch.value).toBeNull();
});
