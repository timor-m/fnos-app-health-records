export type OcrTableCell = { table: string; row: number; column: number; columns: number };

/** Repair only a single explicit-header table. Model row failure is not text failure. */
export function recoverHeaderAlignedTable<T extends { id?: unknown; text?: unknown; box?: unknown; tableUnsafe?: boolean; tableCell?: unknown }>(lines: T[]): T[] {
  const geometry = (box: unknown) => {
    if (!Array.isArray(box)) return null;
    const b = box.flat() as number[];
    if (![4, 8].includes(b.length) || !b.every(Number.isFinite)) return null;
    const xs = b.length === 4 ? [b[0], b[2]] : b.filter((_, i) => i % 2 === 0);
    const ys = b.length === 4 ? [b[1], b[3]] : b.filter((_, i) => i % 2 === 1);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    return right > left && bottom > top ? { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2, height: bottom - top } : null;
  };
  // Leave useful model grids (including genuine empty cells) untouched.
  if (lines.filter(line => line.tableUnsafe).length <= lines.filter(line => validOcrTableCell(line.tableCell)).length) return lines;
  const items = lines.flatMap((line, index) => {
    const box = geometry(line.box);
    return box && typeof line.text === 'string' ? [{ line, index, box, text: line.text.trim() }] : [];
  });
  const names = items.filter(item => /^(项目名称|项目|名称|检验项目|检测项目)$/.test(item.text));
  // Side-by-side/repeated headers need a separate region decision; never guess here.
  if (names.length !== 1) return lines;
  const anchor = names[0];
  const headers = items.filter(item => Math.abs(item.box.y - anchor.box.y) < Math.min(item.box.height, anchor.box.height) / 2
    && /^(序号|缩写|英文缩写|代码|项目名称|项目|名称|检验项目|检测项目|结果|本次结果|检验结果|单位|异常|异常标志|参考范围|参考值|参考区间|方法|方法学|检测方法)$/.test(item.text))
    .sort((a, b) => a.box.x - b.box.x);
  const nameCol = headers.findIndex(item => item === anchor);
  const resultCols = headers.flatMap((item, i) => /^(结果|本次结果|检验结果)$/.test(item.text) ? [i] : []);
  const unitCols = headers.flatMap((item, i) => item.text === '单位' ? [i] : []);
  if (resultCols.length !== 1 || unitCols.length !== 1 || headers.length < 3) return lines;
  // Headers are left-aligned; centre midpoints truncate long names and units.
  const edges = [-Infinity, ...headers.slice(1).map(h => h.box.left - h.box.height), Infinity];
  if (edges.some((edge, i) => i > 0 && edge <= edges[i - 1])) return lines;
  const column = (item: typeof anchor) => edges.findIndex((edge, i) => item.box.x >= edge && item.box.x < edges[i + 1]);
  const body = items.filter(item => item.box.top > anchor.box.bottom
    && (item.line.tableUnsafe || validOcrTableCell(item.line.tableCell)));
  const rowNames = body.filter(item => column(item) === nameCol && /[\p{L}]/u.test(item.text)
    && !/[：:；;。]/.test(item.text)).sort((a, b) => a.box.y - b.box.y);
  if (rowNames.length < 2) return lines;
  const mapping = new Map<number, OcrTableCell>();
  headers.forEach((item, column) => mapping.set(item.index, { table: 'table_99', row: 0, column, columns: headers.length }));
  rowNames.forEach((name, i) => {
    const sameRow = body.filter(item => Math.abs(item.box.y - name.box.y) < Math.min(item.box.height, name.box.height) / 2);
    const results = sameRow.filter(item => column(item) === resultCols[0] && !/^[↑↓↗↘*★☆]+$/.test(item.text));
    const units = sameRow.filter(item => column(item) === unitCols[0]);
    // A missing or conflicting result remains unsafe; reference numbers never substitute.
    if (sameRow.filter(item => column(item) === nameCol && /[\p{L}]/u.test(item.text)).length !== 1
      || results.length !== 1 || units.length > 1
      || !/^(?:[<>≤≥]?\s*[-+]?\d+(?:\s*\.\s*\d+)?|[-+]{1,3}|阴性|阳性)$/.test(results[0].text)) return;
    // Name/result must not extend into the neighbouring core column. A wide unit
    // may include reference text; retain it verbatim for downstream unit checking.
    if ([name, ...results].some(item => {
      const c = column(item);
      const left = item === name ? item.box.left : Math.max(item.box.left, edges[c]);
      return (Math.min(item.box.right, edges[c + 1]) - left) / (item.box.right - item.box.left) < .8;
    })) return;
    const end = Math.min(rowNames[i + 1]?.box.top ?? Infinity, name.box.bottom + name.box.height * 3);
    for (const item of body) {
      const c = column(item);
      const auxiliary = ![nameCol, resultCols[0], unitCols[0]].includes(c);
      if (sameRow.includes(item) || (auxiliary && item.box.top >= name.box.top && item.box.bottom < end)) {
        mapping.set(item.index, { table: 'table_99', row: i + 1, column: c, columns: headers.length });
      }
    }
  });
  if (mapping.size === headers.length) return lines;
  return lines.map((line, index) => mapping.has(index) ? { ...line, tableUnsafe: false, tableCell: mapping.get(index) } : line);
}
export function validOcrTableCell(value: unknown): value is OcrTableCell {
  if (!value || typeof value !== "object") return false;
  const v = value as OcrTableCell;
  return typeof v.table === "string" && /^table_\d{1,2}$/.test(v.table)
    && Number.isInteger(v.row) && v.row >= 0 && v.row <= 1024
    && Number.isInteger(v.columns) && v.columns >= 2 && v.columns <= 64
    && Number.isInteger(v.column) && v.column >= 0 && v.column < v.columns;
}
