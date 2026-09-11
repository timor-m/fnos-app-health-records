import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('storage settings reuses themed controls and keeps migration confirmation', () => {
  const page = readFileSync(new URL('../../ui/src/pages/settings/StorageSettingsPage.vue', import.meta.url), 'utf8');
  const menu = readFileSync(new URL('../../ui/src/pages/SettingsPage.vue', import.meta.url), 'utf8');
  assert.match(menu, /to="\/me\/storage"><HardDrive/);
  assert.match(menu, /to="\/me\/data"><DatabaseBackup/);
  assert.match(page, /<FormSelect v-model="selectedRoot"/);
  assert.doesNotMatch(page, /<select\b/);
  assert.match(page, /confirm\.ask\(/);
  assert.match(page, /!selectedRoot \|\| !storage\.migrationAvailable \|\| storage\.paused/);
  assert.match(page, /overflow-wrap: anywhere/);
  assert.match(page, /@media \(max-width: 760px\)/);
  assert.match(page, /<details class="archive-safety">/);
  assert.doesNotMatch(page, /border-radius:\s*\d/);
  assert.match(page, /title: '清理旧档案副本'.*danger: true/);
  assert.match(page, /migrationId, confirmed: true/);
  assert.match(page, /storage\.migration\.cleanupAvailable/);
  assert.match(page, /本次迁移没有文件校验清单/);
});
