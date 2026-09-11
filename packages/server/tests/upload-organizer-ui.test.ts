import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { computed, ref, watch, reactive, nextTick } from 'vue';
import { transpile, ScriptTarget } from 'typescript';
import { buildUploadPlan } from '../../ui/src/utils/upload-plan.ts';

const organizer = readFileSync('packages/ui/src/components/UploadOrganizer.vue', 'utf8');
const page = readFileSync('packages/ui/src/pages/UploadPage.vue', 'utf8');
const styles = readFileSync('packages/ui/src/styles.css', 'utf8');

test('organization attention scrolls only when outside the usable viewport', () => {
  const script = organizer.slice(organizer.indexOf('watch(() => props.attention'), organizer.indexOf("const requestedMode"));
  const code = transpile(script, { target: ScriptTarget.ES2022 });
  let notify: (value: number) => void = () => {};
  let bounds = { top: 160, bottom: 220 };
  const calls: ScrollIntoViewOptions[] = [];
  const mode = ref('');
  const element = ref({ getBoundingClientRect: () => bounds, scrollIntoView: (options: ScrollIntoViewOptions) => calls.push(options) });
  let reduceMotion = false;
  new Function('watch', 'props', 'mode', 'modesElement', 'window', code)(
    (_source: unknown, callback: typeof notify) => { notify = callback; }, {}, mode, element,
    { innerHeight: 800, matchMedia: () => ({ matches: reduceMotion }) }
  );
  notify(1);
  assert.equal(calls.length, 0);
  bounds = { top: -300, bottom: -240 };
  notify(2);
  assert.deepEqual(calls[0], { block: 'center', inline: 'nearest', behavior: 'smooth' });
  bounds = { top: 900, bottom: 960 };
  reduceMotion = true;
  notify(3);
  assert.equal(calls[1].behavior, 'instant');
  mode.value = 'merge';
  notify(4);
  assert.equal(calls.length, 2);
});

test('save prompts for organization before issuing any upload request', async () => {
  const script = page.slice(page.indexOf('async function submit()'), page.indexOf('\nonBeforeUnmount(() => {\n  clearQueue();'));
  const create = new Function('uploading', 'batchRunning', 'importTasks', 'items', 'canSubmitOrganization', 'organizationMode', 'toast', 'organizationAttention', transpile(script + '\nreturn submit;', { target: ScriptTarget.ES2022 }));
  const mode = ref('');
  const messages: string[] = [];
  const attention = ref(0);
  const submit = create(ref(false), ref(false), ref([]), ref([{ id: 'a' }, { id: 'b' }]), ref(false), mode, { show: (message: string) => messages.push(message) }, attention);
  await submit();
  assert.equal(attention.value, 1);
  await submit();
  assert.equal(attention.value, 2);
  mode.value = 'custom';
  await submit();
  assert.deepEqual(messages, ['请先选择报告组织方式', '请先选择报告组织方式', '请先完成全部文件分组']);
  assert.equal(attention.value, 2);
  assert.match(organizer, /v-if="attention && !mode" :key="attention"/);
  assert.match(organizer, /prefers-reduced-motion: reduce/);
  assert.match(page, /:disabled="uploading \|\| batchRunning" @click="submit"/);
  assert.doesNotMatch(page, /:disabled="uploading \|\| !canSubmitOrganization"/);
});

test('small-screen flat upload rows place metadata and actions on the same second row', () => {
  assert.match(styles, /\.upload-page-item > \.upload-page-info \{ display: contents; \}/);
  assert.match(styles, /\.upload-page-info > strong \{ grid-column: 2 \/ 4; grid-row: 1;/);
  assert.match(styles, /\.upload-page-info > span \{ grid-column: 2; grid-row: 2;[^}]*white-space: nowrap;/);
  assert.match(styles, /\.upload-page-actions \{ grid-column: 3; grid-row: 2;/);
  assert.match(styles, /\.upload-page-item > \.page-thumbnail \{ grid-column: 1; grid-row: 1 \/ 3;/);
});

test('flat upload lists preserve whole-row long press alongside touch sorting buttons', () => {
  assert.match(page, /@pointerdown="pressUploadItem\(\$event, item.id\)"/);
  assert.match(page, /class="upload-sort-ghost"/);
  assert.match(page, /@click.capture="filterSortClick"/);
  assert.match(page, /@pointercancel="endUploadSort"/);
  assert.match(page, /class="upload-touch-sort"/);
  assert.match(page, /:disabled="index === 0 \|\| uploading"/);
  assert.match(page, /:disabled="index === items.length - 1 \|\| uploading"/);
  assert.match(styles, /@media \(pointer: coarse\) \{\s*\.upload-page-actions \.upload-touch-sort \{ display: grid;/);
});

test('touch arrow moves retain selection and scroll the moved row into view', async () => {
  const script = page.slice(page.indexOf('function move(index:'), page.indexOf('function rotate('));
  const code = transpile(script + '\nreturn moveWithButton;', { target: ScriptTarget.ES2022 });
  const items = ref([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const selected = ref('');
  const visible: string[] = [];
  const create = new Function('items', 'uploading', 'finishUploadSort', 'selectedUploadId', 'nextTick', 'uploadList', code);
  const move = create(items, ref(false), () => {}, selected, nextTick, ref({ querySelectorAll: () => ['a', 'b', 'c'].map(id => ({ dataset: { uploadSort: id }, scrollIntoView: () => visible.push(id) })) }));
  await move('b', -1);
  assert.deepEqual(items.value.map(item => item.id), ['b', 'a', 'c']);
  assert.equal(selected.value, 'b');
  assert.deepEqual(visible, ['b']);
  await move('b', -1);
  assert.deepEqual(items.value.map(item => item.id), ['b', 'a', 'c']);
  await move('b', 1);
  assert.deepEqual(items.value.map(item => item.id), ['a', 'b', 'c']);
});

test('sorting shows a pointer-following preview and protects interactive card regions', () => {
  assert.match(organizer, /class="organizer-drag-preview"/);
  assert.match(organizer, /dragPosition.value = \{ x: event.clientX, y: event.clientY \}/);
  assert.match(organizer, /closest\('button, input, select, textarea, a, \[contenteditable\], \[data-no-sort\]'\)/);
  assert.match(organizer, /draggable="false"/);
  assert.match(organizer, /@dragstart.prevent/);
  assert.match(organizer, /const handle = fileGrid.value/);
});

test('sorting uses a touch-safe captured handle and keeps keyboard controls', () => {
  assert.match(organizer, /@pointerdown.stop="startSort/);
  assert.match(organizer, /@pointercancel="endSort"/);
  assert.match(organizer, /@lostpointercapture="endSort"/);
  assert.match(organizer, /touch-action: none/);
  assert.match(organizer, /@keydown.up.prevent/);
  assert.doesNotMatch(organizer, /<ArrowUp|<ArrowDown/);
});

test('touch folder grid uses three columns with a narrow-screen fallback', () => {
  assert.match(organizer, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(organizer, /@media \(max-width: 359px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(organizer, /-webkit-line-clamp: 2/);
});

test('small-screen organization controls use one compact row without shrinking file interactions', () => {
  const mobile = organizer.slice(organizer.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /organizer-modes \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(mobile, /grid-column: 1 \/ -1/);
  assert.match(mobile, /min-height: 54px/);
  assert.match(mobile, /organizer-thumbnail, .organizer-file img \{ height: 64px/);
  assert.match(mobile, /organizer-file-heading input \{ width: 24px; height: 24px/);
});

test('single and non-custom upload lists open the shared image viewer', () => {
  assert.match(page, /class="page-thumbnail upload-thumbnail-preview" type="button"/);
  assert.match(page, /@click="uploadPreviewId = item.id"/);
  assert.match(page, /:start-index="uploadPreviewPages.findIndex/);
  assert.match(page, /function clearQueue\(\) \{\s*finishUploadSort\(\);\s*selectedUploadId.value = '';\s*uploadPreviewId.value = ''/);
});

function setupOrganizer(hitTest = () => null as unknown) {
  const props = reactive({ files: ['a', 'b', 'c', 'd'].map(id => ({ id, name: `${id}.png`, previewUrl: `blob:${id}` })) });
  const script = organizer.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*;\n/gm, '');
  const code = transpile(script + '\nreturn { mode, groups, selected, destination, currentFolder, visibleFiles, previewPages, requestedMode, choose, assign, navigate, releaseSelected, removeFolder, groupRemaining, move, fileGrid, startSort, dragSort, endSort, dropFolderId };', { target: ScriptTarget.ES2022 });
  const create = new Function('computed', 'ref', 'watch', 'onMounted', 'onBeforeUnmount', 'defineProps', 'defineEmits', 'Files', 'Layers', 'LayoutGrid', 'document', 'buildUploadPlan', code);
  return { props, ui: create(computed, ref, watch, (fn: () => void) => fn(), () => {}, () => props, () => () => {}, {}, {}, {}, { elementFromPoint: hitTest }, buildUploadPlan) };
}

test('dropping an unassigned card on another creates exactly one two-file report', () => {
  const target = { closest: (selector: string) => selector === '[data-sort-file]' ? { dataset: { sortFile: 'a' } } : null };
  const { props, ui } = setupOrganizer(() => target);
  ui.choose('custom');
  ui.fileGrid.value = { contains: () => true, setPointerCapture() {}, hasPointerCapture: () => false };
  const event = { pointerId: 1, button: 0, clientX: 10, clientY: 10, preventDefault() {}, type: 'pointerup' };
  ui.startSort(event, 'b');
  ui.dragSort(event);
  assert.equal(ui.groups.value.length, 0);
  ui.endSort({ ...event, type: 'pointercancel' });
  assert.equal(ui.groups.value.length, 0);
  ui.startSort(event, 'b');
  ui.endSort(event);
  assert.equal(ui.groups.value.length, 1);
  assert.deepEqual(ui.groups.value[0].files, ['a', 'b']);
  assert.deepEqual(ui.visibleFiles.value.map((file: { id: string }) => file.id), ['c', 'd']);
  assert.equal(props.files.length, 4);
});

test('mouse movement starts flat-list dragging and updates preview and order before release', () => {
  const script = page.slice(page.indexOf('const uploadList ='), page.indexOf('onDeactivated(() => finishUploadSort'));
  const move = page.slice(page.indexOf('function move(index:'), page.indexOf('function rotate('));
  const code = transpile(script + move + '\nreturn { uploadList, sortId, sortPosition, pressUploadItem, moveUploadSort, endUploadSort };', { target: ScriptTarget.ES2022 });
  const items = ref([{ id: 'a' }, { id: 'b' }]);
  const create = new Function('ref', 'computed', 'items', 'uploading', 'document', code);
  const ui = create(ref, computed, items, ref(false), { elementFromPoint: () => ({ closest: () => ({ dataset: { uploadSort: 'b' } }) }) });
  ui.uploadList.value = { contains: () => true, setPointerCapture() {}, hasPointerCapture: () => false };
  const event = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, target: { closest: () => null }, preventDefault() {}, type: 'pointerup' };
  ui.pressUploadItem(event, 'a');
  ui.moveUploadSort({ ...event, clientY: 80 });
  assert.equal(ui.sortId.value, 'a', 'mouse drag must not be cancelled by the long-press threshold');
  assert.equal(ui.sortPosition.value.y, 80);
  assert.deepEqual(items.value.map(item => item.id), ['b', 'a']);
  ui.endUploadSort({ ...event, type: 'pointercancel' });
  assert.deepEqual(items.value.map(item => item.id), ['a', 'b']);
  ui.pressUploadItem({ ...event, pointerType: 'touch' }, 'a');
  ui.moveUploadSort({ ...event, pointerType: 'touch', clientY: 80 });
  assert.equal(ui.sortId.value, '', 'ordinary touch scroll before long press does not reorder');
});

test('drag into a folder commits only on release; cancellation and outside drops keep files', () => {
  let target: unknown = null;
  const { props, ui } = setupOrganizer(() => target);
  ui.choose('custom');
  ui.selected.value = ['a'];
  ui.assign(true);
  const folder = ui.groups.value[0];
  ui.fileGrid.value = { contains: () => true, setPointerCapture() {}, hasPointerCapture: () => false };
  const event = { pointerId: 1, button: 0, clientX: 10, clientY: 10, preventDefault() {}, type: 'pointerup' };
  target = { closest: (selector: string) => selector === '[data-drop-folder]' ? { dataset: { dropFolder: folder.id } } : null };
  ui.startSort(event, 'b');
  ui.dragSort(event);
  assert.equal(ui.dropFolderId.value, folder.id);
  assert.deepEqual(folder.files, ['a'], 'hover is only a preview');
  ui.endSort({ ...event, type: 'pointercancel' });
  assert.deepEqual(folder.files, ['a']);
  ui.startSort(event, 'b');
  ui.endSort(event);
  assert.deepEqual(folder.files, ['a', 'b']);
  ui.navigate(folder.id);
  assert.deepEqual(ui.selected.value, ['b'], 'the dropped file stays selected when opening its folder');
  ui.navigate();
  target = null;
  ui.startSort(event, 'c');
  ui.endSort(event);
  assert.deepEqual(folder.files, ['a', 'b']);
  assert.equal(props.files.length, 4);
});

test('folder operations preserve every file and support navigation, moves and dissolution', () => {
  const { props, ui } = setupOrganizer();
  ui.choose('custom');
  ui.selected.value = ['a', 'b'];
  ui.assign(true);
  const first = ui.groups.value[0].id;
  assert.deepEqual(ui.visibleFiles.value.map((file: { id: string }) => file.id), ['c', 'd']);
  ui.navigate(first);
  assert.equal(ui.visibleFiles.value.length, 2);
  ui.move(ui.currentFolder.value.files, 1, -1);
  assert.deepEqual(ui.currentFolder.value.files, ['b', 'a']);
  ui.selected.value = ['b'];
  ui.assign(true);
  assert.deepEqual(ui.currentFolder.value.files, ['a']);
  const second = ui.groups.value.find((group: { id: string }) => group.id !== first).id;
  ui.selected.value = ['a'];
  ui.destination.value = second;
  ui.assign(false);
  assert.equal(ui.currentFolder.value, undefined, 'empty source returns to root');
  ui.navigate(second);
  assert.deepEqual(ui.currentFolder.value.files, ['b', 'a']);
  ui.selected.value = ['a'];
  ui.releaseSelected();
  assert.deepEqual(ui.currentFolder.value.files, ['b']);
  ui.removeFolder();
  assert.equal(ui.visibleFiles.value.length, 4);
  assert.equal(props.files.length, 4, 'removing a folder never removes source files');
  ui.groupRemaining();
  assert.equal(ui.groups.value.length, 4);
  assert.equal(ui.visibleFiles.value.length, 0);
  ui.choose('merge');
  assert.equal(ui.mode.value, 'custom');
  assert.equal(ui.requestedMode.value, 'merge');
  ui.choose('merge', true);
  assert.equal(ui.groups.value.length, 0);
});

test('removing a source file cleans stale groups, selection and folder navigation', async () => {
  const { props, ui } = setupOrganizer();
  ui.choose('custom');
  ui.selected.value = ['a'];
  ui.assign(true);
  ui.navigate(ui.groups.value[0].id);
  ui.selected.value = ['a'];
  props.files = props.files.filter(file => file.id !== 'a');
  await nextTick();
  assert.equal(ui.currentFolder.value, undefined);
  assert.equal(ui.selected.value.length, 0);
  assert.equal(ui.visibleFiles.value.length, 3);
});

test('organization preview appears only for multiple files and has no upload side effects', () => {
  assert.match(organizer, /v-if="files.length > 1"/);
  for (const label of ['独立报告', '合并报告', '自定义分组']) assert.ok(organizer.includes(label));
  assert.doesNotMatch(organizer, /requestUpload|fetch\(|utils\/api/);
  assert.match(organizer, /文件传齐后逐份进入识别队列/);
});

test('custom grouping exposes assignment, ordering and reset confirmation', () => {
  for (const action of ['新建报告文件夹', '移动到', '移回全部文件', '拖拽排序', '确认切换']) assert.ok(organizer.includes(action));
  assert.match(organizer, /!confirmed && mode.value === 'custom' && groups.value.length/);
  assert.match(organizer, /selected.value = selected.value.filter/);
  assert.match(organizer, /groups.value = groups.value.filter\(group => group.files.length\)/);
});

test('folder browser replaces the separate grouped list and separates preview from selection', () => {
  assert.match(organizer, /aria-label="报告分组路径"/);
  assert.match(organizer, /返回上一级/);
  assert.match(organizer, /v-if="!currentFolder"/);
  assert.doesNotMatch(organizer, /class="organizer-report"/);
  assert.match(organizer, /<ImageViewer/);
  assert.match(organizer, /@click="previewId = item.id"/);
  assert.match(organizer, /type="checkbox"/);
  assert.match(organizer, /function removeFolder\(\) \{\s*groups.value = groups.value.filter/);
  assert.doesNotMatch(organizer, /props.files.splice|emit\('remove'/);
});

test('new multi-report modes cannot accidentally call the single-report endpoint', () => {
  assert.match(page, /organizationPlan.value.length > 0/);
  assert.match(page, /if \(!canSubmitOrganization.value\) \{[^}]*toast.show/);
  assert.match(page, /uploads\/staged/);
  assert.deepEqual(buildUploadPlan(['a', 'b'], 'custom', [['a']]), []);
  assert.deepEqual(buildUploadPlan(['a', 'b'], 'custom', [['a'], ['a']]), []);
  assert.deepEqual(buildUploadPlan(['a', 'b'], 'custom', [['b', 'a']]), [['b', 'a']]);
  assert.deepEqual(buildUploadPlan(['b', 'a'], 'independent', []), [['b'], ['a']]);
  assert.deepEqual(buildUploadPlan(['b', 'a'], 'merge', []), [['b', 'a']]);
});
