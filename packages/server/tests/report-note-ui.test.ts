import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { computed, ref } from 'vue';
import { transpile, ScriptTarget } from 'typescript';
import { reportNoteLimits, type ReportNote } from '../../shared/report-notes.ts';
import { maxUploadFileBytes } from '../../shared/upload-limits.ts';

const editor = readFileSync('packages/ui/src/components/ReportNoteEditor.vue', 'utf8');
const panel = readFileSync('packages/ui/src/components/ReportNotesPanel.vue', 'utf8');
const styles = readFileSync('packages/ui/src/styles.css', 'utf8');
function editorState(options: { note?: ReportNote; request?: (...args: any[]) => Promise<unknown>; upload?: (...args: any[]) => Promise<unknown> } = {}) {
  const source = editor.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*?;\n/gm, '');
  const events: unknown[][] = [];
  const disposers: Array<() => void> = [];
  const bindings = { computed, ref, defineProps: () => ({ reportId: 'fixture', note: options.note || null }), defineEmits: () => (...args: unknown[]) => events.push(args),
    onBeforeUnmount: (fn: () => void) => disposers.push(fn), onMounted: () => {}, useScrollLock: () => {}, useConfirm: () => ({ ask: () => {} }),
    request: options.request || (async () => ({})), requestUpload: options.upload || (async () => ({ uploadToken: 'fixture' })), apiUrl: (path: string) => `http://localhost/api/${path}`,
    reportNoteLimits, maxUploadFileBytes, window: { innerHeight: 800 }, document: { activeElement: null } };
  const state = new Function(...Object.keys(bindings), transpile(source + '\nreturn { content, images, save, selectFiles, upload, move, preview, viewer, error, saving, busy, createId };', { target: ScriptTarget.ES2022 }))(...Object.values(bindings));
  return { ...state, events, dispose: () => disposers.forEach(fn => fn()) };
}
test('editor rejects empty notes and preserves text/files after save failure', async () => {
  let calls = 0;
  const state = editorState({ request: async () => { calls++; throw new Error('save failed fixture'); } });
  try {
    await state.save(); assert.equal(calls, 0); assert.match(state.error.value, /填写/);
    state.content.value = 'fixture';
    await state.selectFiles([new File(['fixture'], 'fixture.jpg', { type: 'image/jpeg' })]);
    await state.save();
    assert.equal(calls, 1); assert.equal(state.content.value, 'fixture'); assert.equal(state.images.value.length, 1);
    assert.equal(state.images.value[0].status, 'ready'); assert.equal(state.saving.value, false);
    assert.equal(state.events.length, 0); assert.match(state.createId, /^note_[a-f0-9]{32}$/);
  } finally { state.dispose(); }
});
test('per-image retries preserve successful uploads and ordering is submitted to API', async () => {
  let attempts = 0; let payload: any;
  const state = editorState({ upload: async (_path, _body, progress) => { progress(100); if (++attempts === 2) throw new Error('upload failed fixture'); return { uploadToken: `fixture${attempts}` }; },
    request: async (_path, init) => { payload = JSON.parse(init.body); return { id: 'saved' }; } });
  try {
    await state.selectFiles([new File(['a'], 'a.png'), new File(['b'], 'b.png')]);
    assert.equal(state.images.value[0].status, 'ready'); assert.equal(state.images.value[1].status, 'failed');
    await state.save(); assert.equal(payload, undefined); assert.match(state.error.value, /上传失败/);
    await state.upload(state.images.value[1]); assert.equal(attempts, 3);
    state.move(1, -1); state.preview(0); assert.equal(state.viewer.value.pages[0].label, 'b.png');
    await state.save(); assert.deepEqual((payload as any).assets, [{ uploadToken: 'fixture3' }, { uploadToken: 'fixture1' }]);
    assert.equal(state.events[0][0], 'saved');
  } finally { state.dispose(); }
});
test('editor updates existing record and removes images without a second image upload', async () => {
  let route = ''; let payload: any;
  const note: ReportNote = { id: 'fixture-note', contentText: 'fixture', createdAt: 'fixture', updatedAt: 'fixture', createdBy: 'fixture', assets: [{ id: 'fixture-asset', originalName: 'fixture.jpg', fileSize: 1, mimeType: 'image/jpeg', width: null, height: null, sortOrder: 0 }] };
  const state = editorState({ note, request: async (path, init) => { route = path; payload = JSON.parse(init.body); assert.equal(init.method, 'PATCH'); return note; } });
  try {
    state.images.value.splice(0, 1); state.content.value = 'edited fixture'; await state.save();
    assert.match(route, /notes\/fixture-note$/); assert.equal(payload.updatedAt, note.updatedAt); assert.deepEqual(payload.assets, []);
  } finally { state.dispose(); }
});
test('unsupported images and >9 selection are rejected without uploads', async () => {
  let uploads = 0;
  const state = editorState({ upload: async () => { uploads++; return {}; } });
  try {
    await state.selectFiles([new File(['fixture'], 'fixture.pdf')]); assert.match(state.error.value, /不支持/);
    await state.selectFiles(Array.from({ length: 10 }, () => new File(['fixture'], 'fixture.png'))); assert.match(state.error.value, /9/);
    assert.equal(uploads, 0); assert.equal(state.images.value.length, 0);
  } finally { state.dispose(); }
});
test('UI uses member capability, text-safe rendering, shared viewer and flexible touch dialog footer', () => {
  assert.match(panel, /v-if="canManage"/); assert.match(panel, /v-else-if="!notes.length"/);
  assert.match(panel, /v-for="note in notes"/); assert.match(panel, /v-if="note.assets.length"/);
  assert.match(panel, /\{\{ note.contentText \}\}/); assert.doesNotMatch(panel, /v-html/);
  assert.match(panel, /ImageViewer/); assert.match(editor, /ImageViewer/); assert.match(editor, /confirm.ask/);
  assert.match(editor, /report-note-editor-body/); assert.match(editor, /footer class="form-actions report-note-editor-actions"/);
  assert.match(editor, /visualViewport/); assert.match(editor, /@drop.prevent/);
  assert.match(styles, /\.modal-panel.report-note-editor[^}]*height: auto[^}]*max-height:/);
  assert.match(styles, /\.report-note-editor-actions button[^}]*border-radius: var\(--radius-m\)/);
});
