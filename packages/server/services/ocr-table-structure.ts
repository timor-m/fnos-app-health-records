import { wrappedTableNameGroups } from "../utils/wrapped-table-name";
import { isCurrentResultColumn, isExplicitOcrTableHeader, normalizeOcrTableHeader } from './ocr-table-columns';

export type OcrTableCell = { table: string; row: number; column: number; columns: number; headerRow?: number };
type PositionedText = { id?: unknown; sourceLineIds?: string[]; text?: unknown; box?: unknown; confidence?: unknown; tableUnsafe?: boolean; tableCell?: unknown };

function geometry(box: unknown) {
  if (!Array.isArray(box)) return null;
  const b = box.flat() as number[];
  if (![4, 8].includes(b.length) || !b.every(Number.isFinite)) return null;
  const xs = b.length === 4 ? [b[0], b[2]] : b.filter((_, i) => i % 2 === 0);
  const ys = b.length === 4 ? [b[1], b[3]] : b.filter((_, i) => i % 2 === 1);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return right > left && bottom > top
    ? { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2, height: bottom - top }
    : null;
}

const nameHeader = /^(项目名称|项目|名称|参数|检验项目|检测项目|测定项目)$/;
const prefixHeader = /^(序号|缩写|英文缩写|代码)$/;
const headerLabel = /^(项目名称|项目|名称|参数|检验项目|检测项目|测定项目|序号|缩写|英文缩写|代码|结果|本次结果|检验结果|检查结果|测定值|实测值?|测量值|单位|异常|异常标志|标志|标记|参考范围|参考值|参考区间|历史结果|上次结果|前次结果|方法|方法学|检测方法)$/;
const administrativeLabel = /(?:姓名|日期|时间|签名|审核|医生|标本|送检|检验者|备注|声明|报告单|报告编号|仅供|仅对)/;
const recognitionMarker = /^(?:[【[]\s*(?:深圳|全国)?(?:HR|R)\s*[】\]]|(?:深圳|全国)\s*HR)$/i;
const resultText = /^(?:[↑↓▲▼⬆⬇↗↘]?\s*(?:<=|>=|[<>≤≥])?\s*[-+]?\d+(?:\s*\.\s*\d+)?(?:[eE][-+]?\d+)?(?:\s*[-~～]\s*\d+(?:\.\d+)?)?\s*[%‰↑↓▲▼⬆⬇↗↘]?|[-+]{1,3}|阴性|阳性|弱阳性|正常|异常|无|未见(?:异常)?|未查见|未检出|清亮|浑浊|[浅深棕褐黄红黑绿白灰淡]{1,3}色|稀便|糊状|软便|硬便|成形|不成形)$/;

/** A single OCR box may contain the same code in both abbreviation/name columns. */
export function duplicatedOcrCodeName(text: string): string | null {
  const match = text.match(/^([A-Za-z][A-Za-z _-]+)\s+([A-Za-z][A-Za-z0-9_-]+)$/);
  const compact = (value: string) => value.replace(/[ _-]/g, '').toUpperCase();
  return match && compact(match[1]).length >= 3 && compact(match[1]) === compact(match[2]) ? match[2] : null;
}

/** Do not strip numeric identifiers such as B12, D3 or CA19.9 from a name. */
export function duplicatedOcrResultName(text: string, result: string): string | null {
  if (!result || !text.endsWith(result) || !/\d/.test(result)) return null;
  const name = text.slice(0, -result.length).trim();
  return name.length >= 2 && /[\u3400-\u9fff)）\]]$/.test(name) ? name : null;
}

/**
 * Recover explicit header regions independently of the optional table model.
 * Repeated project headers each own a panel, its rows and its column meanings.
 * Only unique name/result pairs are promoted. Missing/conflicting results stay
 * marked unsafe, and useful model cells are never overwritten.
 */
export function recoverHeaderAlignedTable<T extends PositionedText>(
  lines: T[],
  canJoinName?: (first: string, second: string) => boolean,
): T[] {
  // OCR sometimes joins adjacent headings into one box. Split only a complete
  // sequence of known labels, never names, results or arbitrary prose. Estimated
  // heading positions must still pass the existing unique row/column checks.
  const originalLines = lines;
  lines = lines.flatMap((line): T[] => {
    const text = String(line.text || '').normalize('NFKC').replace(/\s+/g, '');
    const labels = text.match(/项目名称|检验项目|检测项目|测定项目|参考范围|参考区间|参考值|本次结果|检验结果|检查结果|结果|单位|序号|序|名称|项目/g);
    const box = geometry(line.box);
    if (!labels || labels.length < 2 || labels.join('') !== text || !box
      || box.right - box.left < box.height * 2 || validOcrTableCell(line.tableCell)) return [line];
    let offset = 0;
    return labels.map((label, index) => {
      const left = box.left + (box.right - box.left) * offset / text.length;
      offset += label.length;
      return { ...line, id: `${line.id}:header:${index}`, text: label,
        sourceLineIds: line.sourceLineIds || [String(line.id)],
        box: [left, box.top, box.left + (box.right - box.left) * offset / text.length, box.bottom] };
    });
  });
  if (lines.length === originalLines.length && lines.every((line, index) => line === originalLines[index])) lines = originalLines;
  // Retry OCR may repeat a value with different spacing. Only coalesce equal
  // text occupying the same area; equal values on other rows remain separate.
  const unique: T[] = [];
  for (const line of lines) {
    const box = geometry(line.box);
    const key = String(line.text || '').normalize('NFKC').replace(/\s+/g, '');
    const index = unique.findIndex(previous => {
      const prior = geometry(previous.box);
      if (!box || !prior || key !== String(previous.text || '').normalize('NFKC').replace(/\s+/g, '')) return false;
      const overlap = Math.max(0, Math.min(box.right, prior.right) - Math.max(box.left, prior.left))
        * Math.max(0, Math.min(box.bottom, prior.bottom) - Math.max(box.top, prior.top));
      return overlap / Math.min((box.right-box.left)*box.height,(prior.right-prior.left)*prior.height) >= .8;
    });
    if (index < 0) unique.push(line);
    else if (Number(line.confidence) > Number(unique[index].confidence)) unique[index] = { ...line, id: unique[index].id };
  }
  if (unique.length !== lines.length) lines = unique;
  const originalItems = lines.flatMap((line, index) => {
    const box = geometry(line.box);
    return box && typeof line.text === 'string' ? [{ line, index, members:[index], box, text: normalizeOcrTableHeader(line.text) }] : [];
  });
  const joined = new Set<number>();
  const items = [...originalItems].sort((a,b)=>a.box.top-b.box.top).flatMap(item => {
    if (joined.has(item.index)) return [];
    const continuation = originalItems.filter(next => next.index !== item.index && !joined.has(next.index)
      && !validOcrTableCell(item.line.tableCell) && !validOcrTableCell(next.line.tableCell)
      && ((next.box.top >= item.box.bottom - item.box.height*.2 && next.box.top-item.box.bottom <= item.box.height*.8
        && Math.abs(next.box.x-item.box.x) <= Math.max(next.box.height,item.box.height))
        // Letter-spaced headings may be separate boxes on the same baseline.
        // Join only incomplete labels, with no intervening cell or model mapping.
        || (!headerLabel.test(item.text) && !headerLabel.test(next.text)
          && next.box.left >= item.box.right && next.box.left-item.box.right <= Math.max(item.box.height,next.box.height)*4
          && Math.abs(next.box.y-item.box.y) <= Math.min(item.box.height,next.box.height)*.35
          && !originalItems.some(between => between !== item && between !== next
            && between.box.x > item.box.x && between.box.x < next.box.x
            && Math.abs(between.box.y-item.box.y) < item.box.height*.65)))
      && /^(项目|项目名称|检验项目|检验结果|结果|单位|参考范围|参考区间|ReferenceRange)$/i.test(item.text+next.text));
    if (continuation.length !== 1) return [item];
    const next=continuation[0]; joined.add(next.index);
    const box=geometry([Math.min(item.box.left,next.box.left),Math.min(item.box.top,next.box.top),Math.max(item.box.right,next.box.right),Math.max(item.box.bottom,next.box.bottom)])!;
    return [{...item,members:[item.index,next.index],box,text:normalizeOcrTableHeader(item.text+next.text)}];
  }).filter(item => !joined.has(item.index));
  const headings = items.filter(item => headerLabel.test(item.text));
  const anchors = headings.filter(item => nameHeader.test(item.text));
  const bands = new Map<string, typeof items>();
  for (const anchor of anchors) {
    // Estimate the baseline before grouping: a horizontal-only prefilter loses
    // distant columns even on a mildly tilted wide report.
    const slopes = [0, ...headings.flatMap(item => {
      const dx = item.box.x - anchor.box.x;
      const slope = (item.box.y - anchor.box.y) / dx;
      return Math.abs(dx) > anchor.box.height * 3 && Math.abs(slope) <= .18 ? [slope] : [];
    })];
    const fits = slopes.map(slope => {
      const members = headings.filter(item => Math.abs(item.box.y - anchor.box.y - slope * (item.box.x - anchor.box.x))
        <= Math.max(item.box.height, anchor.box.height) * .9);
      return { slope, members, residual: members.reduce((sum, item) => sum + Math.abs(item.box.y - anchor.box.y - slope * (item.box.x - anchor.box.x)), 0) };
    }).sort((a, b) => b.members.length - a.members.length || a.residual - b.residual || Math.abs(a.slope) - Math.abs(b.slope));
    const band = fits[0].members.sort((a, b) => a.box.x - b.box.x);
    bands.set(band.map(item => item.index).join(','), band);
  }
  const mapping = new Map<number, OcrTableCell>();
  const unsafe = new Set<number>();
  const usedTables = new Set(lines.flatMap(line => validOcrTableCell(line.tableCell) ? [line.tableCell.table] : []));
  let tableNumber = 99;
  const coveredHeaders = new Set<number>();
  for (const band of [...bands.values()].sort((a, b) => b.length - a.length)) {
    if (band.some(item => coveredHeaders.has(item.index))) continue;
    const starts = band.flatMap((item, index) => nameHeader.test(item.text) ? [index] : []);
    // An abbreviation/serial heading belongs to the project following it.
    const groupStarts = starts.map((start, index) => {
      let first = start;
      while (first > (starts[index - 1] ?? -1) + 1 && prefixHeader.test(band[first - 1].text)) first--;
      return first;
    });
    for (let groupIndex = 0; groupIndex < groupStarts.length; groupIndex++) {
      const headers = band.slice(groupStarts[groupIndex], groupStarts[groupIndex + 1]);
      const nameCol = headers.findIndex(item => nameHeader.test(item.text));
      const resultCols = headers.flatMap((item, i) => isCurrentResultColumn(item.text) ? [i] : []);
      if (nameCol < 0 || resultCols.length !== 1 || headers.length < 2
        || !isExplicitOcrTableHeader(headers.map(item => item.text).join(' | '))
        || headers.some(item => /历史|上次|前次/.test(item.text))) continue;
      const anchor = headers[nameCol];
      const height = Math.max(...headers.map(item => item.box.height));
      const first = headers[0], last = headers[headers.length - 1];
      const slope = (last.box.y - first.box.y) / (last.box.x - first.box.x);
      if (!Number.isFinite(slope) || Math.abs(slope) > .18) continue;
      const y = (item: typeof anchor) => item.box.y - slope * (item.box.x - anchor.box.x);
      // Do not silently drop unrecognised reference/history/date/chart columns.
      // Dedicated matrix and device-chart parsers retain their full header.
      const nextPanel = band[groupStarts[groupIndex + 1]];
      const unsupportedHeader = items.some(item => item.box.x >= first.box.left - height
        && item.box.x < (nextPanel?.box.left ?? Infinity)
        && Math.abs(y(item) - y(anchor)) <= height * .65
        && !headers.includes(item) && /参考|范围|历史|上次|前次|预测|预计|标准|(?:19|20|21)\d{2}[-/.年]/.test(item.text));
      if (unsupportedHeader) continue;
      // Left-aligned headings describe column starts, not centre midpoints.
      // Name headings are often centred above left-aligned project names.
      // Bound the first column by the previous panel, not the heading's left edge.
      const previousPanelHeader = items.filter(item => !headers.includes(item)
        && headerLabel.test(item.text) && Math.abs(y(item) - y(anchor)) <= height * .65
        && item.box.right < first.box.left).sort((a,b)=>b.box.right-a.box.right)[0];
      const firstEdge = nameCol === 0
        ? (previousPanelHeader ? (previousPanelHeader.box.right + first.box.left) / 2 : 0)
        : previousPanelHeader ? (previousPanelHeader.box.right + first.box.left) / 2 : first.box.left - height;
      const edges = [firstEdge, ...headers.slice(1).map((item, index) =>
        index + 1 === nameCol && prefixHeader.test(headers[index].text)
          ? headers[index].box.right + height / 2
          : item.text === '单位' && /^(参考范围|参考值|参考区间)$/.test(headers[index].text)
            ? (headers[index].box.right + item.box.left) / 2
            : item.box.left - height), nextPanel && prefixHeader.test(nextPanel.text)
        ? nextPanel.box.left : last.box.right + height / 2];
      if (edges.some((edge, i) => i > 0 && edge <= edges[i - 1])) continue;
      const column = (item: typeof anchor) => {
        if (item.box.left >= edges[nameCol] && item.box.left < edges[nameCol + 1] && /\p{L}/u.test(item.text)) return nameCol;
        const index = edges.findIndex((edge, i) => item.box.x >= edge && item.box.x < edges[i + 1]);
        return index === 0 && first.text === '序号' && !/^\d{1,3}$/.test(item.text) ? -1 : index;
      };
      const nextHeader = anchors.filter(item => y(item) > y(anchor) + height
        && item.box.x >= edges[0] && item.box.x < edges[edges.length - 1])
        .reduce((bottom, item) => Math.min(bottom, y(item) - item.box.height / 2), Infinity);
      let body = items.filter(item => y(item) > y(anchor) + Math.min(item.box.height, anchor.box.height) / 2
        && y(item) < nextHeader && column(item) >= 0 && !recognitionMarker.test(item.text));
      const modelHeader = headers.some(item => validOcrTableCell(item.line.tableCell));
      const trusted = (item: typeof anchor) => validOcrTableCell(item.line.tableCell) && !item.line.tableUnsafe
        && (modelHeader || item.line.tableCell.columns === headers.length && item.line.tableCell.column === column(item));
      // A wrapped project name belongs to one row only when its full vertical
      // band contains one independent result. OCR boxes can overlap slightly.
      const namePieces = body.filter(item => column(item) === nameCol && !trusted(item)
        && /^[\p{L}\p{N}（）().+%\/-]+$/u.test(item.text) && !administrativeLabel.test(item.text.replace(/[（(][^）)]*[）)]/g,''))
        && !headerLabel.test(item.text));
      const wraps = wrappedTableNameGroups(namePieces, item => item.box, item => item.text,
        (first, second) => !/^(?:请|建议|备注|说明|参考|审核|签名|报告|咨询)/.test(second) && Boolean(canJoinName?.(first, second)),
        group => {
          const first = group[0], last = group.at(-1)!;
          const h = Math.min(...group.map(item => item.box.height));
          const band = body.filter(item => !group.includes(item)
            && item.box.bottom > first.box.top - h * .25 && item.box.top < last.box.bottom + h * .25);
          if (band.some(item => column(item) === nameCol)) return false;
          const results = band.filter(item => column(item) === resultCols[0]);
          return results.length === 1 && resultText.test(results[0].text)
            && results[0].box.top >= first.box.top - h * .25
            && results[0].box.bottom <= last.box.bottom + h * .25;
        });
      body = body.filter(item => !wraps.some(group => group.slice(1).includes(item))).map(item => {
        const group = wraps.find(group => group[0] === item);
        if (!group) return item;
        const box = geometry([Math.min(...group.map(piece => piece.box.left)), item.box.top,
          Math.max(...group.map(piece => piece.box.right)), group.at(-1)!.box.bottom])!;
        return { ...item, box, members: group.flatMap(piece => piece.members), text: group.map(piece => piece.text).join('') };
      });
      const trustedHeaders = headers.filter(trusted);
      const existingTable = trustedHeaders[0]?.line.tableCell as OcrTableCell | undefined;
      // Reuse a model header only when column ownership agrees. Never overwrite
      // good cells, but let failed rows in that same table use geometry.
      if (existingTable && trustedHeaders.some(item => {
        const cell = item.line.tableCell as OcrTableCell;
        return cell.table !== existingTable.table || cell.row !== existingTable.row
          || cell.columns !== headers.length || cell.column !== headers.indexOf(item);
      })) continue;
      let recoveredRow = existingTable ? Math.max(...items.flatMap(item => {
        const cell = item.line.tableCell;
        return validOcrTableCell(cell) && cell.table === existingTable.table ? [cell.row] : [];
      })) + 1 : 1;
      const rowNames = body.filter(item => column(item) === nameCol && /\p{L}/u.test(item.text)
        && !/[：:；;。]/.test(item.text) && !administrativeLabel.test(item.text.replace(/[（(][^）)]*[）)]/g,'')))
        .sort((a, b) => y(a) - y(b));
      const rows = new Map<number, { row: number; column: number; unsafe: boolean }>();
      const conflicting = new Set<number>();
      rowNames.forEach((name, rowIndex) => {
        const sameRow = body.filter(item => Math.abs(y(item) - y(name)) < Math.min(item.box.height, name.box.height) * .65);
        if (sameRow.some(trusted)) return;
        // A lone label may open a new clinical section. Padding it into an
        // empty table row would hide that boundary from downstream parsing.
        if (sameRow.every(item => column(item) === nameCol)) return;
        const rowNumber = recoveredRow++;
        const results = sameRow.filter(item => column(item) === resultCols[0] && !/^[↑↓↗↘*★☆]+$/.test(item.text));
        if (sameRow.filter(item => column(item) === nameCol && /\p{L}/u.test(item.text)).length !== 1) return;
        const result = results[0];
        const gluedCodeResult = results.length === 0
          && /^.+\[[A-Za-z][A-Za-z0-9.\/%# -]*\]\s*[<>≤≥]?\s*\d+(?:\.\d+)?$/.test(name.text)
          && name.box.right > edges[resultCols[0]] + height
          && name.box.right < edges[resultCols[0] + 1];
        // A merged name/value OCR box is usable only if the independent result
        // box overlaps it and repeats the exact printed suffix.
        const duplicatedResult = result && duplicatedOcrResultName(name.text, result.text)
          && name.box.right >= result.box.left && name.box.left < result.box.left;
        const duplicatedCode = nameCol > 0 && prefixHeader.test(headers[nameCol - 1].text)
          && duplicatedOcrCodeName(name.text) && name.box.left < edges[nameCol] && name.box.right > edges[nameCol];
        const crossed = [name, ...results].some(item => {
          if (item === name && (duplicatedResult || duplicatedCode || gluedCodeResult)) return false;
          const col = column(item);
          return (Math.min(item.box.right, edges[col + 1]) - Math.max(item.box.left, edges[col])) / (item.box.right - item.box.left) < .8;
        });
        const rowUnsafe = crossed || (!gluedCodeResult && (results.length !== 1 || !resultText.test(result?.text || '')))
          || [name, ...results].some(item => item.line.confidence != null && Number(item.line.confidence) < .65);
        // Unit fragments are consumed and verified as one complete field by
        // the planner. Their ambiguity cannot invalidate a unique name/result.
        const nextName = rowNames[rowIndex + 1];
        const bottom = Math.min(nextName ? y(nextName) - height / 2 : Infinity, y(name) + height * 3);
        for (const item of body) {
          const col = column(item);
          const auxiliary = ![nameCol, resultCols[0]].includes(col) && headers[col]?.text !== '单位';
          if (sameRow.includes(item) || (auxiliary && y(item) >= y(name) && y(item) + item.box.height / 2 < bottom)) {
            for (const index of item.members) {
              if (rows.has(index) || conflicting.has(index)) { rows.delete(index); conflicting.add(index); continue; }
              if (!trusted(item)) rows.set(index, { row: rowNumber, column: col, unsafe: rowUnsafe });
            }
          }
        }
      });
      if (!rows.size) continue;
      while (usedTables.has(`table_${tableNumber}`) && tableNumber >= 0) tableNumber--;
      if (tableNumber < 0) break;
      const table = existingTable?.table ?? `table_${tableNumber--}`;
      usedTables.add(table);
      headers.forEach((item, column) => {
        if (!trusted(item)) item.members.forEach(index=>mapping.set(index, { table, row: existingTable?.row ?? 0, column, columns: headers.length }));
        coveredHeaders.add(item.index);
      });
      rows.forEach(({ unsafe: rowUnsafe, ...cell }, index) => {
        mapping.set(index, { table, ...cell, columns: headers.length, ...(existingTable ? {headerRow:existingTable.row} : {}) });
        if (rowUnsafe) unsafe.add(index);
      });
    }
  }
  return mapping.size ? lines.map((line, index) => mapping.has(index)
    ? { ...line, tableUnsafe: unsafe.has(index), tableCell: mapping.get(index) } : line) : lines;
}

export function validOcrTableCell(value: unknown): value is OcrTableCell {
  if (!value || typeof value !== 'object') return false;
  const v = value as OcrTableCell;
  return typeof v.table === 'string' && /^table_\d{1,2}$/.test(v.table)
    && Number.isInteger(v.row) && v.row >= 0 && v.row <= 1024
    && Number.isInteger(v.columns) && v.columns >= 2 && v.columns <= 64
    && (v.headerRow === undefined || Number.isInteger(v.headerRow) && v.headerRow >= 0 && v.headerRow <= v.row)
    && Number.isInteger(v.column) && v.column >= 0 && v.column < v.columns;
}

/** Independent coverage check: numbers under printed result headers that never
 * entered a candidate. It reports uncertainty, never manufactures a result. */
export function uncoveredOcrResultIds(lines: PositionedText[], covered: Set<string>): string[] {
  const items = lines.flatMap(line => {
    const box = geometry(line.box);
    return box && typeof line.text === 'string' ? [{line,box,text:normalizeOcrTableHeader(line.text)}] : [];
  });
  const headers = items.filter(item => isCurrentResultColumn(item.text) && headerLabel.test(item.text));
  return items.filter(item => typeof item.line.id === 'string' && !covered.has(item.line.id) && resultText.test(item.text)
    && headers.some(header => {
      const dy = item.box.y - header.box.y;
      if (dy <= header.box.height || Math.abs(item.box.x-header.box.x) > Math.max(header.box.height*3,header.box.right-header.box.left)) return false;
      if (headers.some(next => next !== header && next.box.y > header.box.y && next.box.y < item.box.y
        && Math.abs(next.box.x-header.box.x) < header.box.height*3)) return false;
      return items.some(name => name.box.right <= item.box.left && /\p{L}/u.test(name.text)
        && !administrativeLabel.test(name.text) && !headerLabel.test(name.text)
        && Math.abs(name.box.y-item.box.y) <= Math.max(name.box.height,item.box.height));
    })).map(item=>String(item.line.id));
}
