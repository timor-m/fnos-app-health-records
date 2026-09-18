import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../database/client.ts';
import { recoverHeaderAlignedTable } from '../services/ocr-table-structure.ts';
import { rebuildOcrPages } from '../services/ai-input-planner.service.ts';
import { mappedOcrMeasurement, mappedOcrResultCells } from '../services/ocr-table-columns.ts';

test('paired tables retain independent headers, empty cells and evidence groups', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-paired-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const raw = [
      ['项目名称', '', '结果', '单位', '参考区间', '项目名称', '结果', '单位', '参考区间'],
      ['合成项目甲', '【深圳HR】', '12', 'U/L', '0-30', '合成项目乙', '24', 'mg/L', '0-40'],
      ['合成项目丙', '', '', 'U/L', '0-30', '合成项目丁', '36', '', '0-40'],
    ].flatMap((cells, row) => cells.flatMap((text, column) => text ? [{
      id: `${row}-${column}`, text, confidence: .99,
      box: [column * 200, row * 100, column * 200 + 100, row * 100 + 20],
      tableCell: { table: 'table_0', row, column, columns: 9 },
    }] : []));
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
    const left = page.lines.find(line => line.sourceLineIds.includes('1-0'))!;
    const right = page.lines.find(line => line.sourceLineIds.includes('1-5'))!;
    assert.equal(left.candidateKind, 'scalar');
    assert.equal(right.candidateKind, 'scalar');
    assert.deepEqual(mappedOcrMeasurement(left.text, left.tableHeaderText), { name: '合成项目甲', result: '12' }, JSON.stringify({ text: left.text, header: left.tableHeaderText, scoped: left.projectHeaderCells }));
    assert.deepEqual(mappedOcrMeasurement(right.text, right.tableHeaderText), { name: '合成项目乙', result: '24' });
    assert.equal(left.text.includes('HR'), false);
    assert.equal(left.sourceLineIds.includes('1-1'), true);
    assert.equal(left.sourceLineIds.includes('1-6'), false);
    const empty = page.lines.find(line => line.sourceLineIds.includes('2-0'))!;
    assert.deepEqual(mappedOcrResultCells(empty.text, empty.tableHeaderText), []);
    assert.equal(empty.localObservations.length, 0);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

function fixture() {
  return [
    ['缩写', '项目名称', '结果', '单位', '参考区间', '方法学'],
    ['A', '合成项目甲', '12', 'U/L', '0-30', '方法甲'],
    ['B', '合成项目乙', '24', 'ml/min/1.73m²≥60', '', '方法乙'],
    ['C', '合成项目丙', '', 'U/L', '0-40', '方法丙'],
  ].flatMap((cells, row) => cells.flatMap((text, column) => text ? [{
    id: `${row}-${column}`, text, confidence: .99, tableUnsafe: true,
    box: [column * 200, row * 100, column * 200 + (text.includes('≥') ? 210 : 100), row * 100 + 20],
  }] : []));
}

test('recovers explicit result columns without borrowing reference values or altering OCR', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-header-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const raw = fixture();
    raw.push({ id: 'reference-wrap', text: '增高30-50', confidence: .99, tableUnsafe: true, box: [800, 130, 900, 150] });
    const original = JSON.stringify(raw);
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: original }]);
    const first = page.lines.find(line => line.sourceLineIds.includes('1-1'))!;
    const second = page.lines.find(line => line.sourceLineIds.includes('2-1'))!;
    const empty = page.lines.find(line => line.sourceLineIds.includes('3-1'))!;
    assert.equal(first.tableStructureUnsafe, false);
    assert.equal(first.sourceCells[2].text, '12');
    assert.match(first.sourceCells[4].text, /增高30-50/);
    assert.equal(second.sourceCells[3].text, 'ml/min/1.73m²');
    assert.equal(second.sourceCells[4].text, '≥60');
    assert.deepEqual(second.sourceCells[4].sourceLineIds, ['2-3']);
    assert.equal(second.candidateKind, 'scalar');
    assert.equal(empty.tableStructureUnsafe, true);
    assert.equal(empty.localObservations.length, 0);
    assert.equal(JSON.stringify(raw), original);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

test('recovers rows touching the header and results with abnormal arrows', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-header-touching-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    // 真实布局：首个数据行与表头相贴（top = 表头 bottom - 1），结果带 ↑↓ 异常箭头
    const rows = [
      [{ text: '项目名称', x: 19 }, { text: '缩写', x: 326 }, { text: '结果', x: 473 }, { text: '单位', x: 600 }, { text: '参考区间', x: 775 }],
      [{ text: '★合成项目甲', x: 21 }, { text: 'FTA', x: 326 }, { text: '33.37', x: 473 }, { text: 'pmol/L', x: 620 }, { text: '3.5~7', x: 775 }],
      [{ text: '★合成项目乙', x: 23 }, { text: 'FTB', x: 326 }, { text: '↑79.55', x: 473 }, { text: 'pmol/L', x: 620 }, { text: '10~22', x: 775 }],
    ];
    const raw = rows.flatMap((cells, row) => cells.map(({ text, x }, column) => ({
      id: `${row}-${column}`, text, confidence: .99, tableUnsafe: true,
      box: [x, 85 + row * 24 + (row === 1 ? -1 : 0), x + 90, 105 + row * 24],
    })));
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
    const first = page.lines.find(line => line.sourceLineIds.includes('1-0'))!;
    const second = page.lines.find(line => line.sourceLineIds.includes('2-0'))!;
    assert.equal(first.tableStructureUnsafe, false);
    assert.equal(second.tableStructureUnsafe, false);
    assert.equal(first.candidateKind, 'scalar');
    assert.equal(second.candidateKind, 'scalar');
    assert.match(mappedOcrMeasurement(first.text, first.tableHeaderText)?.name ?? '', /合成项目甲/);
    assert.match(mappedOcrMeasurement(second.text, second.tableHeaderText)?.result ?? '', /79\.55/);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

test('ambiguous result, crossed columns and repeated headers do not get promoted', () => {
  const raw = fixture();
  const duplicate = [...raw, { ...raw.find(line => line.id === '1-2')!, id: 'duplicate', text: '99' }];
  assert.equal(recoverHeaderAlignedTable(duplicate).find(line => line.id === '1-1')?.tableUnsafe, true);
  const crossed = raw.map(line => line.id === '1-2' ? { ...line, box: [350, 100, 650, 120] } : line);
  assert.equal(recoverHeaderAlignedTable(crossed).find(line => line.id === '1-1')?.tableUnsafe, true);
  const repeated = [...raw, { ...raw[1], id: 'second-header', box: [1800, 0, 1900, 20] }];
  assert.equal(recoverHeaderAlignedTable(repeated), repeated);
  const missingHeader = raw.filter(line => line.text !== '结果');
  assert.equal(recoverHeaderAlignedTable(missingHeader), missingHeader);
  const usefulGrid = raw.map((line, i) => ({ ...line, tableUnsafe: i === 0, tableCell: { table: 'table_0', row: 1, column: 0, columns: 6 } }));
  assert.equal(recoverHeaderAlignedTable(usefulGrid), usefulGrid);
});
