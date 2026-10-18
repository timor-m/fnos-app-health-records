import { getDatabase } from '../database/client';
import { rebuildOcrPages, localObservationsForLine } from './ai-input-planner.service';
import { measurementUnitPattern } from './measurement-units.service';

function sameCellUnit(value: string, unit: string) {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    === unit.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function sameCellNumber(value: string, number: number) {
  const compact = value.normalize('NFKC').replace(/\s+/g, '');
  return /^(?:[<>≤≥]=?)?[-+]?(?:\d+\.?\d*|\.\d+)[↑↓▲▼]?$/.test(compact)
    && Number(compact.replace(/^[<>≤≥]=?/, '').replace(/[↑↓▲▼]$/, '')) === number;
}

type OcrCell = { id?: string; text?: string; box?: unknown; confidence?: number; tableCell?: { table?: string; row?: number; column?: number } };

function compact(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function bounds(box: unknown) {
  if (!Array.isArray(box)) return null;
  const points = typeof box[0] === 'number' && box.length >= 4
    ? [[box[0], box[1]], [box[2], box[3]]] : box;
  const xs = points.map((point: unknown) => Array.isArray(point) ? Number(point[0]) : NaN);
  const ys = points.map((point: unknown) => Array.isArray(point) ? Number(point[1]) : NaN);
  if (!xs.length || [...xs, ...ys].some(value => !Number.isFinite(value))) return null;
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

function sameVisualRow(left: OcrCell, right: OcrCell) {
  const a = bounds(left.box), b = bounds(right.box);
  return Boolean(a && b && Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    >= Math.min(a.bottom - a.top, b.bottom - b.top) * .5);
}

function printedUnit(value: string) {
  const compact = value.normalize('NFKC').replace(/\s+/g, '').trim();
  const power = compact.match(/^[*×]10[~^°˚](9|12)\/[lL]$/);
  if (power) return `10^${power[1]}/L`;
  if (/^m[lL]\/min\/1[.]73m[~^]2$/.test(compact)) return 'mL/min/1.73m²';
  return new RegExp(`^(?:${measurementUnitPattern().source})$`, 'iu').test(compact) ? compact : null;
}

/** Restore only units proved by one printed unit header and one matching OCR row. */
function repairExplicitOcrUnitCells(reportId: string) {
  const db = getDatabase();
  const rows = db.prepare(`SELECT o.id,o.item_name AS itemName,o.numeric_value AS numericValue,
    o.unit,o.evidence_json AS evidenceJson FROM observations o
    LEFT JOIN observation_normalizations n ON n.observation_id=o.id
    WHERE o.report_id=? AND o.numeric_value IS NOT NULL
    AND (n.observation_id IS NULL OR n.quality IN ('low','excluded'))
    AND NOT EXISTS(SELECT 1 FROM observation_field_overrides m WHERE m.observation_id=o.id)`)
    .all(reportId) as Array<{id:string;itemName:string;numericValue:number;unit:string|null;evidenceJson:string}>;
  if (!rows.length) return 0;
  const pages = db.prepare(`SELECT p.id AS pageId,p.page_number AS pageNumber,
    (SELECT lines_json FROM ocr_results WHERE page_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) AS linesJson
    FROM report_pages p WHERE p.report_id=?`).all(reportId) as Array<{pageId:string;pageNumber:number;linesJson:string|null}>;
  const rawPages = new Map(pages.flatMap(page => {
    try {
      const parsed = JSON.parse(page.linesJson || 'null');
      return Array.isArray(parsed) ? [[page.pageNumber, {pageId:page.pageId, cells:parsed as OcrCell[]}]] as const : [];
    } catch { return []; }
  }));
  let updated = 0;
  for (const row of rows) {
    let evidence: any[];
    try { evidence = JSON.parse(row.evidenceJson); } catch { continue; }
    if (!Array.isArray(evidence)) continue;
    let recoveredUnit: string | null = null;
    let conflictingUnit = false;
    let changed = false;
    const next = evidence.map(entry => {
      if (!entry?.table || entry.table.sourceMap?.unit || !Array.isArray(entry.table.rowSourceLineIds)
        || !Array.isArray(entry.table.headerSourceLineIds)) return entry;
      const page = rawPages.get(entry.pageNumber);
      if (!page || (entry.pageId && entry.pageId !== page.pageId)) return entry;
      const cells = page.cells.filter(cell => typeof cell.id === 'string' && typeof cell.text === 'string'
        && bounds(cell.box) && (cell.confidence === undefined || cell.confidence >= .65));
      const rowIds = new Set<string>(entry.table.rowSourceLineIds);
      const headerIds = new Set<string>(entry.table.headerSourceLineIds);
      const itemName = compact(row.itemName).replace(/^★/, '');
      const names = cells.filter(cell => rowIds.has(cell.id!) && compact(cell.text!).replace(/^★/, '') === itemName);
      const embeddedNames = cells.filter(cell => rowIds.has(cell.id!)
        && compact(cell.text!).replace(/^★/, '') === `${itemName}${row.numericValue}`);
      const name = names.length === 1 ? names[0] : names.length === 0 && embeddedNames.length === 1 ? embeddedNames[0] : null;
      if (!name) return entry;
      const results = cells.filter(cell => sameCellNumber(cell.text!, row.numericValue)
        && sameVisualRow(name, cell) && bounds(cell.box)!.left > bounds(name.box)!.left);
      if (results.length !== 1) return entry;
      const result = results[0];
      const headers = cells.filter(cell => headerIds.has(cell.id!) && compact(cell.text!) === '单位'
        && bounds(cell.box)!.left > bounds(name.box)!.left);
      if (!headers.length) return entry;
      const unitHeader = headers.sort((a,b) => bounds(a.box)!.left - bounds(b.box)!.left)[0];
      const headerBounds = bounds(unitHeader.box)!;
      const unitCells = cells.filter(cell => cell.id !== name.id && cell.id !== result.id
        && sameVisualRow(name, cell) && bounds(cell.box)!.left > bounds(result.box)!.left
        && Math.abs((bounds(cell.box)!.left + bounds(cell.box)!.right - headerBounds.left - headerBounds.right) / 2)
          <= Math.max(80, (headerBounds.right - headerBounds.left) * 2)
        && (!name.tableCell || !cell.tableCell ||
          (cell.tableCell.table === name.tableCell.table && cell.tableCell.row === name.tableCell.row)))
        .map(cell => ({cell, unit:printedUnit(cell.text!)}))
        .filter(candidate => candidate.unit && (!row.unit || compact(candidate.unit) === compact(row.unit)));
      if (unitCells.length !== 1) return entry;
      if (recoveredUnit && recoveredUnit !== unitCells[0].unit) {
        conflictingUnit = true;
        return entry;
      }
      const {cell, unit} = unitCells[0];
      recoveredUnit = unit;
      changed = true;
      return {...entry,table:{...entry.table,
        rowSourceLineIds:[...new Set([...entry.table.rowSourceLineIds,name.id,result.id,cell.id])],
        sourceMap:{...entry.table.sourceMap,
          unit:{text:cell.text,sourceLineIds:[cell.id],inherited:false,
            headerSourceLineIds:[unitHeader.id],headerText:'单位'}}}};
    });
    if (!changed || !recoveredUnit || conflictingUnit) continue;
    const changes = db.prepare(`UPDATE observations SET unit=COALESCE(unit,?),evidence_json=?
      WHERE id=? AND evidence_json=? AND (unit IS NULL OR unit=?)`)
      .run(recoveredUnit,JSON.stringify(next),row.id,row.evidenceJson,row.unit).changes;
    updated += Number(changes);
  }
  return updated;
}

/** Reattach legacy unit provenance only when the same OCR row proves every field. */
export function repairLegacyObservationUnitEvidence(reportId: string) {
  const db = getDatabase();
  const explicitRepairs = repairExplicitOcrUnitCells(reportId);
  const rows = db.prepare(`SELECT o.id,o.item_name AS itemName,o.result_text AS resultText,
    o.numeric_value AS numericValue,o.unit,o.evidence_json AS evidenceJson
    FROM observations o JOIN observation_normalizations n ON n.observation_id=o.id
    WHERE o.report_id=? AND n.excluded_reason IS NOT NULL AND o.unit IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM observation_field_overrides m WHERE m.observation_id=o.id)`)
    .all(reportId) as Array<{id:string;itemName:string;resultText:string;numericValue:number|null;unit:string|null;evidenceJson:string}>;
  if (!rows.length) return explicitRepairs;
  const pages = db.prepare(`SELECT p.id AS pageId,p.page_number AS pageNumber,
    (SELECT lines_json FROM ocr_results WHERE page_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) AS linesJson
    FROM report_pages p WHERE p.report_id=? ORDER BY p.page_number`).all(reportId)
    .filter(p=>typeof p.linesJson==='string') as Array<{pageId:string;pageNumber:number;linesJson:string}>;
  const rebuilt = rebuildOcrPages(pages);
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const rawPages = new Map<number, Array<{id?:string;text?:string}>>();
  for (const page of pages) {
    try {
      const lines = JSON.parse(page.linesJson);
      if (Array.isArray(lines)) rawPages.set(page.pageNumber, lines);
    } catch { /* Invalid OCR cannot prove a unit. */ }
  }
  let updated=0;
  for (const row of rows) {
    let evidence: any[];
    try { evidence=JSON.parse(row.evidenceJson); } catch { continue; }
    if (!Array.isArray(evidence) || !row.unit || row.numericValue===null) continue;
    let changed=false;
    const next=evidence.map(entry=>{
      if (!entry || entry.table?.sourceMap?.unit || !Array.isArray(entry.table?.rowSourceLineIds)) return entry;
      const page=rebuilt.find(p=>p.pageNumber===entry.pageNumber);
      if (!page || (entry.pageId && entry.pageId!==page.pageId)) return entry;
      const oldIds=new Set(entry.table.rowSourceLineIds);
      const matches=page.lines.filter(line=>!line.tableStructureUnsafe && line.sourceLineIds.every(id=>oldIds.has(id)))
        .flatMap(line=>localObservationsForLine(line).filter(fact=>
          compact(fact.itemName)===compact(row.itemName) && fact.numericValue===row.numericValue
          && compact(fact.resultText)===compact(row.resultText) && fact.unit && compact(fact.unit)===compact(row.unit!)
          && fact.sourceMap.unit && !fact.sourceMap.unit.inherited && fact.sourceMap.unit.sourceLineIds.length
        ).map(fact=>({line,fact})));
      if (matches.length===1) {
        const {line,fact}=matches[0];
        changed=true;
        return {...entry,table:{...entry.table,headerText:line.tableHeaderText,
          headerSourcePageNumber:line.tableHeaderSourcePageNumber,
          headerSourceLineIds:line.tableHeaderSourceLineIds || [],rowSourceLineIds:line.sourceLineIds,
          sourceMap:fact.sourceMap}};
      }
      if (matches.length>1) return entry;
      // An unsafe table may not yield a planner fact, while its individual OCR
      // cells still prove one name, one result and one printed unit in this row.
      const ids = entry.table.rowSourceLineIds;
      if (!ids.length || new Set(ids).size !== ids.length) return entry;
      const raw = rawPages.get(entry.pageNumber) || [];
      const cells = raw.filter(cell=>typeof cell.id==='string' && ids.includes(cell.id));
      if (cells.length!==ids.length || cells.some(cell=>raw.filter(other=>other.id===cell.id).length!==1)) return entry;
      const nameCells=cells.filter(cell=>compact(cell.text||'')===compact(row.itemName));
      const resultCells=cells.filter(cell=>sameCellNumber(cell.text||'',row.numericValue!));
      const unitCells=cells.filter(cell=>sameCellUnit(cell.text||'',row.unit!));
      if (nameCells.length!==1 || resultCells.length!==1 || unitCells.length!==1
        || new Set([nameCells[0].id,resultCells[0].id,unitCells[0].id]).size!==3) return entry;
      changed=true;
      return {...entry,table:{...entry.table,sourceMap:{...entry.table.sourceMap,
        unit:{text:unitCells[0].text,sourceLineIds:[unitCells[0].id],inherited:false}}}};
    });
    if (changed) {
      updated+=Number(db.prepare('UPDATE observations SET evidence_json=? WHERE id=? AND evidence_json=?')
        .run(JSON.stringify(next),row.id,row.evidenceJson).changes);
    }
  }
  return updated + explicitRepairs;
}
