import assert from 'node:assert/strict';
import test from 'node:test';
import { collectOriginalNarrativeSections, originalNarrativeFieldsFromSections, parseNarrativeSectionReferences } from '../services/report-original-narrative';
const page=(pageNumber:number,texts:string[])=>({pageNumber,lines:texts.map((text,index)=>({id:`p${pageNumber}-${index}`,text}))});

test('retains every department summary, conclusion, finding and recommendation in source order',()=>{
 const pages=[page(1,['检查所见：','所见原文甲。','结论：合成结论甲。','医生建议：','建议原文甲。','内科小结：','内科小结原文。']),
  page(2,['第 2 页','外科小结：','外科小结原文。','超声结论：','合成结论乙。','医生建议：','建议原文乙。','临床诊断：','其他字段不得混入。'])];
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections(pages));
 for(const [field,texts]of Object.entries({findings:['所见原文甲。'],summary:['内科小结原文。','外科小结原文。'],impression:['合成结论甲。','合成结论乙。'],recommendation:['建议原文甲。','建议原文乙。']})){
  for(const text of texts) assert.ok(fields[field as keyof typeof fields]?.includes(text),`${field}: ${text}`);
 }
 assert.ok(fields.summary!.indexOf('内科小结原文。')<fields.summary!.indexOf('外科小结原文。'));
 assert.ok(!fields.recommendation!.includes('其他字段不得混入'));
 assert.ok(!fields.summary!.includes('第 2 页\n'));
});

test('keeps long multi-page source text beyond the previous field caps',()=>{
 const content=Array.from({length:12},(_,p)=>Array.from({length:35},(_,i)=>`条目${p}-${i}：${'合成报告原始叙事内容，保留原标点。'.repeat(14)}`));
 const pages=content.map((lines,index)=>page(index+1,[...(index===0?['医生建议：']:[]),...lines,`第 ${index+1} 页`]));
 const text=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections(pages)).recommendation!;
 assert.ok(text.length>100000);
 for(const line of content.flat()) assert.ok(text.includes(line));
});

test('deduplicates OCR identities and repeated whole pages but retains identical medical lines in different departments',()=>{
 const p=page(1,['内科小结：','原始内容'.repeat(30),'未见明显异常。','外科小结：','未见明显异常。']);
 p.lines.splice(2,0,{...p.lines[1]});
 const duplicate={...p,pageNumber:2};
 const sections=collectOriginalNarrativeSections([p,duplicate]);
 const text=originalNarrativeFieldsFromSections(sections).summary!;
 assert.equal(text.split('原始内容'.repeat(30)).length-1,1);
 assert.equal(text.split('未见明显异常。').length-1,2);
});

test('removes only adjacent page overlap within a section',()=>{
 const overlap='跨页重复原文：'+'内容'.repeat(20);
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([
  page(1,['检查所见：','第一段。',overlap]),page(2,[overlap,'第二段。','结论：','另一个章节重复原文：'+overlap])
 ]));
 assert.equal(fields.findings!.split(overlap).length-1,1);
 assert.ok(fields.findings!.includes('第一段。'));assert.ok(fields.findings!.includes('第二段。'));
 assert.ok(fields.impression!.includes(overlap));
});

test('AI can only assign unique bounded OCR spans, never introduce or rewrite content',()=>{
 const pages=[page(1,['非标准章节标题','首段原文。','末段原文。','不属于选中章节。'])];
 const references=parseNarrativeSectionReferences([{field:'summary',p:1,startQuote:'非标准章节标题',endQuote:'末段原文。'}]);
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections(pages,references));
 assert.ok(fields.summary!.includes('首段原文。'));assert.ok(!fields.summary!.includes('不属于选中章节。'));
 assert.equal(collectOriginalNarrativeSections(pages,[{...references[0],startQuote:'AI新写的概述'}]).length,0);
 assert.equal(collectOriginalNarrativeSections([page(1,['相同','段落','相同'])],[{...references[0],startQuote:'相同',endQuote:'段落'}]).length,0);
 assert.equal(collectOriginalNarrativeSections([page(1,['标题','结论：','结论原文'])],[{...references[0],startQuote:'标题',endQuote:'结论原文'}]).length,1); // Explicit heading wins.
 assert.equal(parseNarrativeSectionReferences([{field:'made-up',p:1,startQuote:'a',endQuote:'b'}]).length,0);
});

test('keeps aligned two-column narratives independent rather than interleaving their rows',()=>{
 const lines=[
  {text:'检查所见：',box:[0,0,80,20]}, {text:'医生建议：',box:[500,0,580,20]},
  {text:'左栏所见第一行。',box:[0,30,220,50]}, {text:'右栏建议第一行。',box:[500,30,720,50]},
  {text:'左栏所见第二行。',box:[0,60,220,80]}, {text:'右栏建议第二行。',box:[500,60,720,80]},
 ];
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([{pageNumber:1,lines}]));
 assert.ok(fields.findings!.includes('左栏所见第一行。\n左栏所见第二行。'));
 assert.ok(!fields.findings!.includes('右栏'));assert.ok(!fields.recommendation!.includes('左栏'));
});

test('repeated report headers do not break continuation, while numbered unrelated sections end it',()=>{
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([
  page(1,['合成长报告','医生建议：','第一页完整原文。']),
  page(2,['合成长报告','第二页接续原文。','二、血常规','不得混入建议的指标表格']),
 ]));
 assert.ok(fields.recommendation!.includes('第二页接续原文。'));
 assert.ok(!fields.recommendation!.includes('不得混入建议'));
});

test('ablation: explicit source chapters remain complete without AI text or section pointers',()=>{
 const pages=[page(1,['概述：','完整原文甲。','结论：','完整原文乙。','医生建议：','完整原文丙。'])];
 const baseline=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections(pages));
 const withWrongPointers=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections(pages,[
  {field:'findings',pageNumber:1,startQuote:'概述：',endQuote:'完整原文丙。'},
  {field:'summary',pageNumber:1,startQuote:'完整原文甲。',endQuote:'完整原文甲。'},
 ]));
 assert.deepEqual(withWrongPointers,baseline);
});

test('separates a paired health overview and doctor advice table and excludes educational continuation',()=>{
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([
  {pageNumber:1,lines:[
   {text:'一般健康问题：',box:[40,140,120,158]}, {text:'医师建议：',box:[300,140,360,158]},
   {text:'合成健康问题甲。',box:[40,170,240,190]}, {text:'合成医生建议甲。',box:[300,170,520,190]},
   {text:'合成健康问题乙。',box:[40,210,240,230]}, {text:'合成医生建议乙。',box:[300,210,520,230]},
  ]},page(2,['医学科普','【合成知识标题】','通用科普正文不得作为个性化建议。']),
  page(3,['续页科普正文也不得混入。']),
 ]));
 assert.ok(fields.summary!.includes('合成健康问题甲。'));assert.ok(!fields.summary!.includes('医生建议'));
 assert.ok(fields.recommendation!.includes('合成医生建议乙。'));assert.ok(!fields.recommendation!.includes('健康问题'));
 assert.ok(!fields.recommendation!.includes('科普'));
});

test('bracketed departments and table header bands stop sections without treating a hint column as a conclusion',()=>{
 const lines=[{text:'【一般检查】'}, {text:'小结：'}, {text:'合成小结原文。'}, {text:'【内科】'}, {text:'科室明细不属于小结'},
  ...['项目','结果','提示','单位','参考范围'].map((text,index)=>({text,box:[index*100,100,index*100+70,120]})),
  {text:'明细行不属于结论'}, {text:'小结：'}, {text:'另一科小结原文。'}];
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([{pageNumber:1,lines}]));
 assert.equal(fields.impression,null);assert.ok(!fields.summary!.includes('明细'));
 assert.ok(fields.summary!.includes('一般检查 · 小结'));assert.ok(fields.summary!.includes('内科 · 小结'));
});

test('AI pointers to rebuilt table rows resolve to the complete underlying OCR cells',()=>{
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([page(1,['合成项目','完整所见首行，','完整所见末行。','无关尾段。'])],[
  {field:'findings',pageNumber:1,startQuote:'合成项目 | 完整所见首行，',endQuote:'完整所见末行。'},
 ]));
 assert.ok(fields.findings!.includes('合成项目\n完整所见首行，\n完整所见末行。'));assert.ok(!fields.findings!.includes('无关尾段'));
});

test('PDF font drawing order cannot move a bold summary ahead of its table content',()=>{
 const lines=[{text:'小结',box:[40,200,70,214]}, {text:'【一般检查】',box:[40,20,140,34]},
  {text:'项目',box:[40,50,70,64]}, {text:'结果',box:[170,50,210,64]},
  {text:'不应混入的小表格项目',box:[40,90,140,104]}, {text:'另一个表格单元格',box:[170,90,290,104]},
  {text:'应保留的完整科室小结原文。',box:[170,200,390,214]}];
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([{pageNumber:1,lines}]));
 assert.ok(fields.summary!.includes('应保留的完整科室小结原文。'));
 assert.ok(!fields.summary!.includes('表格单元格'));assert.ok(!fields.summary!.includes('小表格项目'));
});

test('coarse AI source spans split into separate departments without swallowing their summaries',()=>{
 const first='第一处检查的原始描述，完整保留正文及标点。';
 const second='第二处检查的原始描述，完整保留正文及标点。';
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([page(1,[
  '【器官甲检查】',first,'小结：','甲科小结不得混入所见。',
  '【器官乙检查】',second,'小结：','乙科小结不得混入所见。',
 ])],[{field:'findings',pageNumber:1,startQuote:first,endQuote:second}]));
 assert.ok(fields.findings!.includes(first));assert.ok(fields.findings!.includes(second));
 assert.ok(!fields.findings!.includes('不得混入'));assert.ok(fields.summary!.includes('甲科小结不得混入所见。'));
});

test('links each aligned numbered problem to its complete advice without rewriting either column',()=>{
 const lines=[{text:'一般健康问题',box:[40,100,120,115]},{text:'医师建议',box:[300,100,360,115]},
  {text:'1、合成问题甲，',box:[40,140,240,155]},{text:'补充原始描述。',box:[40,160,240,175]},
  {text:'建议甲首行，',box:[300,140,520,155]},{text:'建议甲末行。',box:[300,165,520,180]},
  {text:'2、合成问题乙。',box:[40,210,240,225]},{text:'建议乙全文。',box:[300,210,520,225]}];
 const sections=collectOriginalNarrativeSections([{pageNumber:1,lines}]);
 const advice=sections.filter(section=>section.field==='recommendation');
 assert.deepEqual(advice.map(section=>section.relatedIssue),['1、合成问题甲，\n补充原始描述。','2、合成问题乙。']);
 assert.deepEqual(advice.map(section=>section.lines.map(line=>line.text).filter(text=>text!=='医师建议')), [['建议甲首行，','建议甲末行。'],['建议乙全文。']]);
 const fields=originalNarrativeFieldsFromSections(sections);
 assert.ok(fields.recommendation!.includes('对应问题：1、合成问题甲，\n补充原始描述。'));
 // Ablation: no geometry means no fabricated problem/advice association.
 const plain=collectOriginalNarrativeSections([{pageNumber:1,lines:lines.map(({text})=>({text}))}]);
 assert.ok(plain.every(section=>!section.relatedIssue));
 const shifted=lines.map(line=>line.text==='建议乙全文。'?{...line,box:[300,240,520,255]}:line);
 assert.ok(collectOriginalNarrativeSections([{pageNumber:1,lines:shifted}]).every(section=>!section.relatedIssue));
});

test('single-column plain departments and labelled examination names scope all narrative fields',()=>{
 const sections=collectOriginalNarrativeSections([page(1,[
  '呼吸内科','概述：','甲科概述原文。','检查所见：','甲科所见原文。','结论：','甲科结论原文。','医生建议：','甲科建议原文。',
  '科室：消化内科','检查项目：合成胃镜检查','概述：','乙科概述原文。','检查所见：','乙科所见原文。','结论：','乙科结论原文。','医生建议：','乙科建议原文。',
 ])]);
 for(const field of ['summary','findings','impression','recommendation']) {
  const chunks=sections.filter(section=>section.field===field);
  assert.equal(chunks.length,2);assert.ok(chunks[0].title.startsWith('呼吸内科 · '));
  assert.ok(chunks[1].title.startsWith('合成胃镜检查 · '));
 }
});

test('qualified titles replace the previous department and scope later generic conclusions',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['【内科】','小结：','甲科原文。','胸部CT所见：','胸部原文。','结论：','胸部结论原文。','外科概述：','外科原文。'])]);
 assert.equal(sections.find(s=>s.field==='findings')!.title,'胸部CT所见');
 assert.equal(sections.find(s=>s.field==='impression')!.title,'胸部CT · 结论');
 assert.equal(sections.at(-1)!.title,'外科概述');
});

test('subprojects inside narrative chapters remain separate and retain their short original text',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['检查所见：','胸部CT','甲。','腹部CT','乙。','结论：','乙检查结论。'])]);
 const findings=sections.filter(s=>s.field==='findings');
 assert.deepEqual(findings.map(s=>s.title),['胸部CT · 检查所见','腹部CT · 检查所见']);
 assert.deepEqual(findings.map(s=>s.lines.map(l=>l.text)),[['甲。'],['乙。']]);
 assert.equal(sections.find(s=>s.field==='impression')!.title,'腹部CT · 结论');
});

test('centred project cells split coarse findings spans and retain short normal descriptions',()=>{
 const lines=[{text:'【超声科】',box:[20,0,100,12]},
  {text:'项目',box:[20,30,50,42]},{text:'结果',box:[180,30,210,42]},
  {text:'器官甲',box:[20,68,70,80]},
  {text:'甲项所见首行，完整保留此处较长的原始描述。',box:[180,60,440,72]},
  {text:'甲项末行。',box:[180,75,300,87]},
  {text:'器官乙',box:[20,110,70,122]},{text:'未见异常。',box:[180,110,280,122]},
  {text:'小结',box:[20,150,50,162]},{text:'甲乙检查小结原文。',box:[180,150,400,162]}];
 const sections=collectOriginalNarrativeSections([{pageNumber:1,lines}],[{
  field:'findings',pageNumber:1,startQuote:'甲项所见首行，完整保留此处较长的原始描述。',endQuote:'未见异常。',
 }]);
 const findings=sections.filter(s=>s.field==='findings');
 assert.deepEqual(findings.map(s=>s.title),['超声科 · 器官甲','超声科 · 器官乙']);
 assert.deepEqual(findings.map(s=>s.lines.map(l=>l.text)),[['甲项所见首行，完整保留此处较长的原始描述。','甲项末行。'],['未见异常。']]);
 assert.equal(sections.find(s=>s.field==='summary')!.title,'超声科 · 小结');
});

test('cross-page continuations retain their project while a new report clears the old context',()=>{
 const sections=collectOriginalNarrativeSections([
  page(1,['检查项目：胸部CT','检查所见：','第一页完整原文。']),
  page(2,['第二页接续原文。','结论：','原件结论。']),
  page(3,['另一份检查报告','概述：','没有科室标题的独立原文。']),
 ]);
 assert.ok(sections.filter(s=>s.pageNumber<=2).every(s=>s.title.startsWith('胸部CT · ')));
 assert.equal(sections.find(s=>s.pageNumber===3)!.title,'概述');
});

test('ambiguous table geometry and ordinary result phrases never fabricate examination context',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['结论：','正常心电图','未见异常，建议复查CT。'])]);
 assert.equal(sections.length,1);assert.equal(sections[0].title,'结论');
 assert.deepEqual(sections[0].lines.map(l=>l.text),['结论：','正常心电图','未见异常，建议复查CT。']);
});

test('two-column qualified department headings keep the same narrative field in separate groups',()=>{
 const sections=collectOriginalNarrativeSections([{pageNumber:1,lines:[
  {text:'呼吸内科所见',box:[20,20,140,35]}, {text:'消化内科所见',box:[400,20,520,35]},
  {text:'甲科第一行。',box:[20,60,240,75]}, {text:'乙科第一行。',box:[400,60,620,75]},
  {text:'甲科第二行。',box:[20,90,240,105]}, {text:'乙科第二行。',box:[400,90,620,105]},
 ]}]);
 assert.deepEqual(sections.map(s=>s.title),['呼吸内科所见','消化内科所见']);
 assert.deepEqual(sections.map(s=>s.lines.slice(1).map(l=>l.text)),[['甲科第一行。','甲科第二行。'],['乙科第一行。','乙科第二行。']]);
});

test('ablation: unlabelled table rows without geometry retain prose without inventing item ownership',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['【超声科】','器官甲','第一段原文，完整保留检查描述。','器官乙','第二段原文，完整保留检查描述。'])],[{
  field:'findings',pageNumber:1,startQuote:'第一段原文，完整保留检查描述。',endQuote:'第二段原文，完整保留检查描述。',
 }]);
 assert.equal(sections.length,1);assert.equal(sections[0].title,'超声科');
 assert.ok(sections[0].lines.some(line=>line.text==='第二段原文，完整保留检查描述。'));
});

test('numbered and parenthesized department formats use their literal source context',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['（一）呼吸内科','小结：','甲科原文。','（消化内科）','结论：','乙科原文。','检查项目：胃镜','检查所见：','丙检查原文。'])]);
 assert.deepEqual(sections.map(s=>s.title),['呼吸内科 · 小结','消化内科 · 结论','胃镜 · 检查所见']);
});

test('split project labels retain current and historical conclusions across pages with their own project and date',()=>{
 const sections=collectOriginalNarrativeSections([
  page(1,['超声检查报告单','检查科室：','超声科','检查项目：','器官甲、器官乙超声检查']),
  page(2,['超声描述：','本次所见完整原文。','超声提示：','本次结论完整原文。','报告医师：合成医师']),
  page(3,['历史检查结果（1）','2000-01-01 合成机构','检查项目：','器官甲超声检查','超声提示：','历史结论完整原文。']),
  page(4,['心电图检查报告单','检查项目：','静态心电图检查','检查结果：','心电图结论原文。']),
 ]);
 const conclusions=sections.filter(s=>s.field==='impression');
 assert.ok(conclusions[0].title.startsWith('器官甲、器官乙超声检查 · '));
 assert.equal(conclusions[1].title,'历史检查结果（1） · 2000-01-01 · 器官甲超声检查 · 超声提示');
 assert.equal(conclusions[2].title,'静态心电图检查 · 检查结果');
 assert.ok(!conclusions[2].title.includes('历史'));
 assert.ok(sections.every(s=>s.lines.every(l=>!l.text.includes('合成机构')&&!l.text.includes('合成医师'))));
});

test('paired ECG description and result columns remain distinct and carry the common examination context',()=>{
 const lines=[{text:'心电图检查报告单',box:[20,10,200,25]},
  {text:'检查时间：2000-01-01',box:[20,35,180,48]},
  {text:'检查项目：',box:[20,60,80,74]},{text:'静态心电图检查',box:[100,60,230,74]},
  {text:'检查描述：',box:[20,110,100,124]}, {text:'检查结果：',box:[400,110,480,124]},
  {text:'心电图描述完整原文。',box:[20,140,250,154]},{text:'心电图结论完整原文。',box:[400,140,650,154]},
  {text:'医师签名：合成署名',box:[20,200,230,214]}];
 const sections=collectOriginalNarrativeSections([{pageNumber:1,lines}]);
 const fields=originalNarrativeFieldsFromSections(sections);
 assert.ok(fields.findings!.includes('心电图描述完整原文。'));assert.ok(!fields.findings!.includes('结论完整'));
 assert.ok(fields.impression!.includes('心电图结论完整原文。'));assert.ok(!fields.impression!.includes('描述完整'));
 assert.ok(sections.every(s=>s.title.includes('心电图')));
});

test('scanned quadrilateral boxes and a new report title stop the preceding report before page header rows',()=>{
 const quad=(x:number,y:number,w=200)=>[[x,y],[x+w,y],[x+w,y+14],[x,y+14]];
 const sections=collectOriginalNarrativeSections([
  page(1,['检查项目：胸部CT','结论：','甲报告结论。']),
  {pageNumber:2,lines:[{text:'合成页眉不能混入上一份结论',box:quad(20,10)},
   {text:'超声骨密度检测报告',box:quad(20,40)}, {text:'(Age)',box:quad(20,70)}, {text:'[cm/s]',box:quad(20,90)},
   {text:'诊断意见',box:quad(20,120)}, {text:'乙报告结论。',box:quad(20,150)}, {text:'检查医生',box:quad(20,190)}]},
  page(3,['没有章节归属的下一页正文不得串入。']),
 ]);
 const conclusions=sections.filter(s=>s.field==='impression');
 assert.equal(conclusions.length,2);assert.equal(conclusions[1].title,'超声骨密度检测报告 · 诊断意见');
 assert.deepEqual(conclusions[1].lines.map(l=>l.text),['诊断意见','乙报告结论。']);
 assert.ok(sections.every(s=>s.lines.every(l=>!l.text.includes('合成页眉')&&!l.text.includes('下一页正文'))));
});

test('education pages cannot continue the previous clinical field or reopen it through generic advice headings',()=>{
 const sections=collectOriginalNarrativeSections([
  page(1,['动脉检查报告单','诊断所见：','检查结论原文。']),
  page(2,['合成页眉','专家健康宣教 Expert Health Education','医学知识正文。','医生建议：','科普中的建议并非本次医嘱。']),
  page(3,['接续科普文字不得作为结论。']),
 ]);
 assert.equal(sections.length,1);assert.equal(sections[0].field,'impression');
 assert.ok(!originalNarrativeFieldsFromSections(sections).impression!.includes('科普'));
});

test('ambiguous metadata does not use a source result sentence as its project name',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['检查项目：','未见异常。','结论：','独立结论原文。'])]);
 assert.equal(sections[0].title,'结论');
});

test('ordinary source advice ending with the word report does not start a new subreport',()=>{
 const fields=originalNarrativeFieldsFromSections(collectOriginalNarrativeSections([page(1,['医生建议：','请妥善保存本报告','完整建议末段。'])]));
 assert.ok(fields.recommendation!.includes('请妥善保存本报告'));assert.ok(fields.recommendation!.includes('完整建议末段。'));
});

test('combined abnormal findings and health advice retain every project group until the original chapter ends',()=>{
 const sections=collectOriginalNarrativeSections([page(1,[
  '异常结果与健康建议 Abnormal Findings and Health Recommendations','本次体检的异常结果汇总及建议',
  '【一般检查】','甲项异常结果及原始建议。','【超声成像检查】','乙项异常结果及原始建议。','主检医师：合成署名',
  '【血常规】','项目','结果','不得作为建议的表格内容。',
 ])]);
 const advice=sections.filter(s=>s.field==='recommendation');
 assert.deepEqual(advice.map(s=>s.title),['一般检查 · 本次体检的异常结果汇总及建议','超声成像检查 · 本次体检的异常结果汇总及建议']);
 assert.ok(advice[1].lines.some(l=>l.text==='乙项异常结果及原始建议。'));
 assert.ok(!originalNarrativeFieldsFromSections(sections).recommendation!.includes('表格内容'));
});

test('table of contents headings cannot become recommendations or suppress the following real chapter',()=>{
 const sections=collectOriginalNarrativeSections([
  page(1,['目录','异常结果与健康建议','专家健康宣教']),
  page(2,['异常结果与健康建议','本次体检的异常结果汇总及建议','【一般检查】','真实章节的完整建议原文。']),
 ]);
 assert.equal(sections.length,1);assert.equal(sections[0].pageNumber,2);
 assert.ok(sections[0].lines.some(l=>l.text==='真实章节的完整建议原文。'));
});

test('method parentheses remain inside project captions and the first-review signature ends combined advice',()=>{
 const sections=collectOriginalNarrativeSections([page(1,['本次体检的异常结果汇总及建议','【超声骨密度（跟骨）检测】','完整建议原文。','初审医师：','合成署名不应进入正文','【合成印章】','印章文字不得作为建议'])]);
 assert.equal(sections.length,1);assert.equal(sections[0].title,'超声骨密度（跟骨）检测 · 本次体检的异常结果汇总及建议');
 assert.deepEqual(sections[0].lines.map(l=>l.text),['完整建议原文。']);
});
