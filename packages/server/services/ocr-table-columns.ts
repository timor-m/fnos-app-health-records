/** Preserve empty cells: removing them changes the meaning of every later column. */
export function splitOcrTableCells(text: string): string[] {
  return text.split(/[|｜]/).map((cell) => cell.trim());
}

/** Only split complete repeated project groups; never split history/result columns. */
export function ocrProjectColumnGroups(header: string): Array<{ start: number; end: number }> {
  if (!isExplicitOcrTableHeader(header)) return [];
  const cells = splitOcrTableCells(header);
  const starts = cells.flatMap((cell, index) => /^(项目名称|项目|名称|参数|检验项目|检测项目|测定项目)$/.test(cell) ? [index] : []);
  if (starts.length < 2 || starts[0] !== 0) return [];
  const groups = starts.map((start, index) => ({ start, end: starts[index + 1] ?? cells.length }));
  return groups.every(({ start, end }) => cells.slice(start, end).filter(isCurrentResultColumn).length === 1) ? groups : [];
}

export function isCurrentResultColumn(cell: string): boolean {
  return /(?:本次结果|检查结果|检验结果|测定值|实测值?|测量值|结果)/.test(cell)
    && !/(?:历史|既往|上次|前次|往年|预测|预计|%\s*预测|参考)/.test(cell);
}

/** null means no usable header; [] means ambiguous structure: do not guess. */
export function mappedOcrResultCells(text: string, header?: string | null): string[] | null {
  if (!header) return null;
  const columns = splitOcrTableCells(header);
  const resultIndexes = columns.flatMap((cell, index) => isCurrentResultColumn(cell) ? [index] : []);
  if (!resultIndexes.length) return null;
  const cells = splitOcrTableCells(text);
  // A text-only OCR line has no recovered cells; retain the existing inline parser.
  if (cells.length === 1) return null;
  // Repeated side-by-side tables require name-specific groups, not a union of results.
  if (resultIndexes.length !== 1 || cells.length !== columns.length) return [];
  return cells[resultIndexes[0]] ? [cells[resultIndexes[0]]] : [];
}

export function isExplicitOcrTableHeader(text: string): boolean {
  const cells = splitOcrTableCells(text);
  return cells.length >= 2
    && cells.every((cell) => !cell || /^(?:项目名称|项目|名称|参数|检验项目|检测项目|测定项目|序号|缩写|英文缩写|代码|结果|本次结果|检验结果|检查结果|测定值|实测值?|测量值|单位|异常|异常标志|标志|标记|参考范围|参考值|参考区间|历史结果|上次结果|前次结果|方法|方法学|检测方法)$/.test(cell.replace(/^(结果|本次结果|单位)[（(][^()（）]+[）)]$/, '$1')))
    && cells.some((cell) => /项目|名称|参数/.test(cell))
    && cells.some(isCurrentResultColumn);
}

export function mappedOcrMeasurement(text: string, header?: string | null) {
  const results = mappedOcrResultCells(text, header);
  if (!header || results?.length !== 1) return null;
  const names = splitOcrTableCells(header).flatMap((cell, index) =>
    /(?:项目|名称|参数)/.test(cell) && !/(?:结果|参考|单位)/.test(cell) ? [index] : []);
  if (names.length !== 1) return null;
  const name = splitOcrTableCells(text)[names[0]];
  if (!name || !/[\p{L}]/u.test(name)) return null;
  return { name, result: results[0] };
}

/** Restore a unit only from the same explicit table; conflicting units stay unresolved. */
export function mappedOcrUnit(text: string, header?: string | null): string | null {
  if (!header || !mappedOcrMeasurement(text, header)) return null;
  const headers = splitOcrTableCells(header);
  const cells = splitOcrTableCells(text);
  const units = headers.flatMap((h, i) => h === '单位' && cells[i] ? [cells[i]] : []);
  const shared = headers.flatMap(h => {
    const match = h.match(/^(?:结果|本次结果|单位)[（(]([^()（）]+)[）)]$/);
    return match ? [match[1].trim()] : [];
  });
  const candidates = [...new Set([...units, ...shared])];
  if (candidates.length !== 1) return null;
  const unit = candidates[0];
  return /[A-Za-zµμ%‰]/.test(unit) && /^[A-Za-zµμ\d%‰/^²³·.*×+\-]+$/.test(unit) ? unit : null;
}
