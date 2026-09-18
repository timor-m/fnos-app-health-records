/** Preserve empty cells: removing them changes the meaning of every later column. */
export function splitOcrTableCells(text: string): string[] {
  return text.split(/[|｜]/).map((cell) => cell.trim());
}

/*
 * 检验单常见的行首序号列：表头没有序号列，数据行第一格却是 1~3 位序号
 * （尾部空列如"方法"被丢弃时，行格数还会恰好与表头相等，错位更隐蔽）。
 * 序号也可能被 OCR 误读成 1~3 个 ASCII 字母（如 "5"→"LC"）；表头自带缩写/代码列时
 * 首格可能是真缩写，字母形态不按序号处理。
 * 仅当左移后首格含文字（项目名）、次格含数字（结果）时才认定首格是序号，
 * 避免误伤数字开头的项目名；左移后不足表头长度的尾部按空单元格补齐。
 */
function alignRowNumberPrefix(cells: string[], columns: string[]): string[] {
  if (cells.length < 3) return cells;
  if (/^(?:序号|项号|编号|NO\.?)$/i.test(columns[0] || "")) return cells;
  const first = cells[0];
  const digitPrefix = /^\d{1,3}$/.test(first);
  const letterNoise =
    /^[A-Za-z]{1,3}$/.test(first) &&
    !columns.some((cell) => /缩写|代码/.test(cell));
  if (!digitPrefix && !letterNoise) return cells;
  if (
    cells.length < columns.length - 1 ||
    cells.length > columns.length + 1
  ) {
    return cells;
  }
  const shifted = cells.slice(1);
  if (!/[\p{L}]/u.test(shifted[0] || "")) return cells;
  if (!/\d/.test(shifted[1] || "")) return cells;
  while (shifted.length < columns.length) shifted.push("");
  return shifted;
}

/*
 * 尾部空列在行重组时被丢弃（如常年空着的"方法"列）：恰好少一格、首格含文字、
 * 后续格含数字的数据行尾部补空格恢复列对齐。叙述行、名称数字粘连行
 * （24小时尿蛋白、13C 呼气试验）不满足条件，保持原有"不猜测"行为。
 */
function padDroppedTrailingCells(cells: string[], columns: string[]): string[] {
  if (cells.length < 2 || cells.length !== columns.length - 1) return cells;
  if (!/[\p{L}]/u.test(cells[0])) return cells;
  if (!cells.slice(1).some((cell) => /\d/.test(cell))) return cells;
  return [...cells, ""];
}

/** 数据行单元格与表头对齐：先处理独立序号格，再补尾部丢弃的空格。 */
function alignOcrRowCells(text: string, columns: string[]): string[] {
  const cells = splitOcrTableCells(text);
  const shifted = alignRowNumberPrefix(cells, columns);
  if (shifted !== cells) return shifted;
  return padDroppedTrailingCells(cells, columns);
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
  const cells = alignOcrRowCells(text, columns);
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
  const columns = splitOcrTableCells(header);
  /* 兼容单列简写表头「项 | 结果 | …」（项=项目）；序号列错位已由 mappedOcrResultCells 对齐 */
  const names = columns.flatMap((cell, index) =>
    /(?:项目|名称|参数|^项$)/.test(cell) && !/(?:结果|参考|单位)/.test(cell) ? [index] : []);
  if (names.length !== 1) return null;
  const name = alignOcrRowCells(text, columns)[names[0]];
  if (!name || !/[\p{L}]/u.test(name)) return null;
  return { name, result: results[0] };
}

/** Restore a unit only from the same explicit table; conflicting units stay unresolved. */
export function mappedOcrUnit(text: string, header?: string | null): string | null {
  if (!header || !mappedOcrMeasurement(text, header)) return null;
  const headers = splitOcrTableCells(header);
  const cells = alignOcrRowCells(text, headers);
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
