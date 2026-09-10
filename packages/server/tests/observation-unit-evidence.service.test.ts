import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { normalizeObservation } from '../services/indicator-normalization.service.ts';

test('unit evidence follows verified row columns and inherited headers, never unrelated pages or invented units', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit-evidence-'));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES ('u','fixture');
      INSERT INTO health_members(id,display_name,created_by) VALUES ('m','fixture','u');
      INSERT INTO reports(id,member_id,created_by,title,report_type,status) VALUES ('r','m','u','fixture','laboratory','ready');`);
    for (const number of [1,2,3]) {
      db.prepare(`INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256)
        VALUES (?, 'r', ?, 'fixture.png', 'fixture.png','image/png',1,'fixture')`).run(`p${number}`,number);
      db.prepare(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,pipeline_version,deduplication_key)
        VALUES (?, 'r', ?, 'ocr','fixture',?)`).run(`j${number}`,`p${number}`,`j${number}`);
      const lines = number === 1 ? [{id:'header',text:'项目 | 结果 | 单位(mmol/L)'}]
        : number === 2 ? [{id:'row',text:'空腹血糖 5'}, {id:'unit',text:'mmol/L'}] : [{id:'unrelated',text:'g/L'}];
      db.prepare(`INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES (?,?,?,'fixture','fixture',?)`)
        .run(`ocr${number}`,`j${number}`,`p${number}`,JSON.stringify(lines));
    }
    const row = { id:'o',reportId:'r',sectionName:null,itemCode:null,itemName:'空腹血糖',normalizedName:null,
      resultText:'5',numericValue:5,unit:'mmol/L',referenceText:null,hasAiExtraction:1,reportType:'laboratory',
      hospitalName:null,performingDepartment:null,reportingDepartment:null };
    const evidence = (sourceIds: string[], inherited: boolean, rowIds = ['row'], headerIds = ['header']) => JSON.stringify([
      {pageNumber:2,quote:'空腹血糖 5',table:{rowSourceLineIds:rowIds,headerSourceLineIds:headerIds,
        sourceMap:{unit:{text:'mmol/L',sourceLineIds:sourceIds,inherited}}}}
    ]);
    const inherited = normalizeObservation({...row,evidenceJson:evidence(['header'],true)});
    assert.ok(['high','medium'].includes(inherited.quality), inherited.excludedReason || 'header unit should pass');
    assert.ok(['high','medium'].includes(normalizeObservation({...row,evidenceJson:evidence(['unit'],false,['row','unit'])}).quality));
    for (const bad of [evidence(['unrelated'],true),evidence(['header'],false),evidence(['missing'],true),evidence(['unit'],false)]) {
      assert.match(normalizeObservation({...row,evidenceJson:bad}).excludedReason || '', /单位无法回指/);
    }
    assert.match(normalizeObservation({...row,unit:'mg/dL',evidenceJson:evidence(['header'],true)}).excludedReason || '', /单位无法回指/);
    assert.match(normalizeObservation({...row,itemName:'总蛋白',unit:'g/L',evidenceJson:JSON.stringify([{pageNumber:2,quote:'总蛋白 5 mg/L'}])}).excludedReason || '', /单位无法回指/);
    // Manual correction remains an explicit alternative; no value-size inference is introduced.
    assert.ok(['high','medium'].includes(normalizeObservation({...row,manualReviewed:1,evidenceJson:'[]'}).quality));
    // Real workers reuse line ids on each page. An explicit header page must disambiguate them.
    db.prepare("UPDATE ocr_results SET lines_json = ? WHERE page_id = 'p3'").run(JSON.stringify([{id:'header',text:'单位 g/L'}]));
    const linked = JSON.parse(evidence(['header'],true));
    linked[0].table.headerSourcePageNumber = 1;
    assert.ok(['high','medium'].includes(normalizeObservation({...row,evidenceJson:JSON.stringify(linked)}).quality));
    linked[0].table.headerSourcePageNumber = 3;
    assert.match(normalizeObservation({...row,evidenceJson:JSON.stringify(linked)}).excludedReason || '', /单位无法回指/);
  } finally { closeDatabaseForTests(); delete process.env.STORAGE_DIR; rmSync(dir,{recursive:true,force:true}); }
});
