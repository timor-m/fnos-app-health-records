import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('global confirmation is above report lists and touch editors', () => {
  const component = readFileSync(new URL('../../ui/src/components/ConfirmDialog.vue', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8');
  assert.match(component, /class="[^"]*confirm-backdrop/);
  assert.match(component, /Teleport to="body"/);
  const layer = Number(css.match(/\.modal-backdrop\.confirm-backdrop\s*\{\s*z-index:\s*(\d+)/)?.[1]);
  const listLayer = Number(css.match(/\.modal-backdrop\.observation-all-backdrop\s*\{\s*z-index:\s*(\d+)/)?.[1]);
  assert.ok(layer > listLayer);
  assert.ok(layer > 130, 'must cover touch observation editor');
});
