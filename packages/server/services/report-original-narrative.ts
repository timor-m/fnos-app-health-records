/** Original OCR text is the content authority; AI may only point to bounded source spans. */
export const originalNarrativeFields = ['summary', 'impression', 'recommendation', 'findings'] as const;
export type OriginalNarrativeField = typeof originalNarrativeFields[number];
export type NarrativeSectionReference = {
  field: OriginalNarrativeField; pageNumber: number; startQuote: string; endQuote: string;
};
export type NarrativeOcrLine = { id?: string; text: string; box?: unknown; sourceBreak?: boolean; tableHeader?: boolean; relatedIssue?: string; tableItem?: boolean; sourceContext?: {title:string;kind:'department'|'exam';block:boolean}; contextValue?:boolean; narrativeField?:OriginalNarrativeField; columnContext?:string };
export type NarrativeOcrPage = { pageNumber: number; lines: NarrativeOcrLine[] };
export type OriginalNarrativeSection = {
  field: OriginalNarrativeField; title: string; pageNumber: number; lines: NarrativeOcrLine[]; relatedIssue?: string;
};
export function parseNarrativeSectionReferences(value: unknown): NarrativeSectionReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || !originalNarrativeFields.includes(item.field) || !Number.isSafeInteger(item.p ?? item.pageNumber)
      || (item.p ?? item.pageNumber) < 1 || typeof item.startQuote !== 'string' || !item.startQuote.trim()
      || typeof item.endQuote !== 'string' || !item.endQuote.trim()
      || item.startQuote.length > 300 || item.endQuote.length > 300) return [];
    return [{field:item.field, pageNumber:item.p ?? item.pageNumber, startQuote:item.startQuote.trim(), endQuote:item.endQuote.trim()}];
  });
}
const headings: Array<[OriginalNarrativeField, RegExp]> = [
  ['recommendation', /^(?:总检|医师|医生|医嘱|健康|诊疗|处理|复查|随访|诊断)?(?:建议|指导)(?:及建议)?$/],
  ['recommendation', /^(?:异常结果与健康建议|本次体检的异常结果汇总及建议|医生建议|医师建议|健康建议|总检建议|处理意见|诊疗建议|复查建议|随访建议|出院医嘱|医嘱|结论及建议|总结及建议|诊断及建议)$/],
  ['findings', /^(?:检查所见|检验所见|影像所见|超声所见|超声描述|检查描述|所见|镜下所见|肉眼所见|检查结果描述)$/],
  ['impression', /^(?:检查结论|检测结论|影像结论|超声结论|总检结论|诊断结论|体检结论|超声提示|影像提示|诊断意见|诊断提示|诊断所见|诊断报告|检查提示|提示|结论|印象)$/],
  ['summary', /^(?:原报告概述|报告概述|概述|一般健康问题|摘要|总结|总检小结|体检小结|科室小结|检查小结|小结|总评|综述|体检综述|异常汇总|异常结果汇总|阳性发现)$/],
];
function heading(text: string) {
  const value = text.trim().replace(/^(异常结果与健康建议)\s*[A-Za-z].*$/, '$1').replace(/^[【\[（(]?\s*(?:[一二三四五六七八九十]+|\d+)[、.．]\s*/, '');
  const match = /^[【\[（(]?([^\n：:】\]）)]{1,24})[】\]）)]?\s*(?:[:：]\s*([\s\S]*))?$/.exec(value);
  if (!match) return null;
  const title = match[1].trim();
  for (const [field, pattern] of headings) {
    if (pattern.test(title) || (/^(?:.+科|.+检查|.+超声|.+彩超|.+CT|.+MRI|.+MR|.+X线|.+内镜|.+胃镜|.+肠镜)[：:]?/.test(title) && /(?:小结|结论|所见|建议|概述)$/.test(title))) {
      const inferred = title==='诊断所见'?'impression':/建议$/.test(title) ? 'recommendation' : /所见$/.test(title) ? 'findings'
        : /(?:小结|概述)$/.test(title) ? 'summary' : /结论$/.test(title) ? 'impression' : field;
      return {field:inferred as OriginalNarrativeField,title,inlineContent:Boolean(match[2]?.trim())};
    }
  }
  return null;
}
function lineHeading(line:NarrativeOcrLine) {
  return heading(line.text) || (line.narrativeField?{field:line.narrativeField,title:line.text.trim().replace(/[:：]$/,''),inlineContent:false}:null);
}
function sourceReportTitle(text:string) {
  if(heading(text) || /详见|建议|请|仅供|参考|本报告/.test(text)) return '';
  return /^([^\n：:，。；]{2,45}(?:报告单|报告|检查单))(?:[A-Za-z][A-Za-z ]*)?$/.test(text.replace(/\s+/g,''))?text.trim():'';
}
function reportContext(title:string) {
  return /超声|彩超|心电|肺功能|呼气|骨密度|动脉|人体成[分份]|CT|MRI|放射|病理|内镜|胃镜|肠镜|脑电|听力|报告单$|检验报告$|检测报告$|分析报告$|检查单$/i.test(title)?title:'';
}
// PDF labels and their values are often separate text cells. Attach context
// without editing either source line, so cached source quotes still resolve.
function sourceLayout(lines:NarrativeOcrLine[]):NarrativeOcrLine[] {
  const result=lines.map(line=>({...line}));
  for(const [index,line]of result.entries()) {
    if(/^(?:检查科室|执行科室|科室|检查项目|检查名称|项目名称|检查部位)[:：]$/.test(line.text.trim())) {
      const a=line.box as number[]|undefined;
      const neighbours=Array.isArray(a)&&a.length===4&&a.every(Number.isFinite)?result.filter(other=>{
        const b=other.box as number[]|undefined;
        return Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>a[2]&&Math.abs(b[1]-a[1])<4;
      }).sort((left,right)=>(left.box as number[])[0]-(right.box as number[])[0]):result.slice(index+1,index+2);
      if(!neighbours.length && Array.isArray(a)) {
        const following=result[index+1],b=following?.box as number[]|undefined;
        if(Array.isArray(b) && Number.isFinite(b[1]) && b[1]>a[1] && b[1]-a[3]<Math.max((a[3]-a[1])*3,45)) neighbours.push(following);
      }
      const value=neighbours[0];
      if(value && value.text.trim().length<=80 && !/[:：]|报告|姓名|性别/.test(value.text) && !heading(value.text) && /[\u4e00-\u9fff]|\b(?:CT|MRI|MR|ECG)\b/i.test(value.text) && !/[。；]|建议|未见|增高|降低|正常|异常/.test(value.text)) {
        line.sourceContext={title:value.text.trim(),kind:/科室/.test(line.text)?'department':'exam',block:false};
        value.contextValue=true;
      }
    }
    // A paired descriptive result panel (e.g. ECG) is a narrative conclusion;
    // an ordinary numeric table's result column is left to table detection.
    if(/^检查结果[:：]?$/.test(line.text.trim()) && Array.isArray(line.box) && line.box.length===4) {
      const a=line.box as number[];
      if(result.some(other=>/^(?:检查描述|检查所见)[:：]?$/.test(other.text.trim()) && Array.isArray(other.box)
        && (other.box as number[])[2]+40<a[0] && Math.abs((other.box as number[])[1]-a[1])<4)) line.narrativeField='impression';
    }
  }
  return result;
}
const sectionFooter=/^(?:报告医师|报告医生|初审医师|终审医师|初审医生|终审医生|审核医师|审核医生|检查医师|检查医生|检测医生|检验者|审核者|检查者|医师|医生|报告时间|检查时间|医生签名|医师签名|主检医师|主检医生|总检医师|总检医生|签名)(?:\s*[:：]|\s*$)/;
const boundary = /^(?:一般检查|体格检查|内科|外科|眼科|耳鼻喉科|口腔科|妇科|检验检查|检验结果|检验项目|项目名称|检查项目|血常规|尿常规|肝功能|肾功能|心电图|临床诊断|主诉|现病史|既往史|处方|用药记录|报告信息)(?:[：:]|\s|$)/;
const furniture = /^(?:Abnormal Findings and Health Recommendations|第\s*\d+\s*页(?:\s*[\/／,，]?\s*共\s*\d+\s*页)?|共\s*\d+\s*页|Page\s*\d+(?:\s*of\s*\d+)?|\d+\s*[\/／]\s*\d+|(?:初审医师|终审医师|报告医师|审核医师|检查医师|检验者|审核者|检查者|医师|医生|打印时间|报告编号|检查编号|姓名|性别|身份证号)\s*[:：][^\n]*)$/i;
// Context is always copied from an explicit source heading or label, never
// inferred from a result sentence. Keep unrecognised body text untouched.
function contextHeading(text:string): {title:string; kind:'department'|'exam'; block:boolean}|null {
  if(heading(text)) return null;
  const value=text.trim().replace(/^(?:(?:[一二三四五六七八九十]+|\d+)[、.．]|[（(](?:[一二三四五六七八九十]+|\d+)[）)])\s*/, '');
  const labelled=/^(?:检查科室|执行科室|科室|检查项目|检查名称|项目名称|检查部位)\s*[:：]\s*([^\n]{1,60})$/.exec(value);
  if(labelled) return {title:labelled[1],kind:/科室/.test(value.split(/[:：]/)[0])?'department':'exam',block:false};
  const bracketed=/^[【\[]([^】\]]{1,40})[】\]]$/.exec(value) || /^[（(]([^）)]{1,40})[）)]$/.exec(value);
  const title=(bracketed?.[1]||value).trim();
  if(/[：:，。；]|建议|复查|未见|异常|就诊|请|正常|备注|姓名|性别|年龄|参考范围|参考值|单位/.test(title)) return null;
  if(bracketed && /[\u4e00-\u9fff]/.test(title) || /^(?:[\u4e00-\u9fffA-Za-z0-9+（）() /-]{1,24}(?:科|彩超|超声|CT|MRI|MR|X线|心电图|内镜|胃镜|肠镜|检查|检测)|血常规|尿常规|肝功能|肾功能|心电图|胃镜|肠镜|超声|CT|MRI|MR)$/i.test(title)) {
    return {title,kind:/科$/.test(title)?'department':'exam',block:Boolean(bracketed) || /^(?:[一二三四五六七八九十]+|\d+)[、.．]/.test(text.trim())};
  }
  return null;
}
const isBoundary = (text:string) => {
  const clean=text.trim().replace(/^[【\[（(]?\s*(?:[一二三四五六七八九十]+|\d+)[、.．]\s*/, '');
  return Boolean(contextHeading(text)) || boundary.test(clean.replace(/^[【\[]|[】\]]$/g,'')) ||
    (!heading(text) && /^[【\[][^】\]]{1,40}[】\]]$/.test(text.trim()));
};
const key = (text: string) => text.replace(/[\s|｜]+/g, '');
function uniqueIndex(lines: NarrativeOcrLine[], quote: string, end=false) {
  const texts=lines.map(line=>key(line.text)), needle=key(quote), joined=texts.join('');
  const start=joined.indexOf(needle);
  if(!needle || start<0 || joined.indexOf(needle,start+1)>=0) return -1;
  const offset=end ? start+needle.length-1 : start;
  let cursor=0;
  for(const [index,text]of texts.entries()) {cursor+=text.length;if(offset<cursor)return index;}
  return -1;
}
// Embedded PDF text may be emitted in drawing/font order (all bold headings
// first). Restore row order from coordinates before detecting section boundaries.
function spatialOrder(lines: NarrativeOcrLine[]): NarrativeOcrLine[] {
  lines=lines.map(line=>{
    const box=line.box;
    if(!Array.isArray(box) || box.length!==4 || !box.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite))) return line;
    return {...line,box:[Math.min(...box.map(p=>p[0])),Math.min(...box.map(p=>p[1])),Math.max(...box.map(p=>p[0])),Math.max(...box.map(p=>p[1]))]};
  });
  const boxed=lines.filter(line=>Array.isArray(line.box) && line.box.length===4 && line.box.every(Number.isFinite));
  if(boxed.length<lines.length*0.8 || boxed.filter(line=>{const b=line.box as number[];return b[3]-b[1]>b[2]-b[0];}).length>boxed.length/2) return lines;
  return [...lines].sort((left,right)=>{
    const a=left.box as number[]|undefined,b=right.box as number[]|undefined;
    if(!Array.isArray(a)||!Array.isArray(b)) return 0;
    const overlap=Math.min(a[3],b[3])-Math.max(a[1],b[1]);
    return overlap>Math.min(a[3]-a[1],b[3]-b[1])*0.4 ? a[0]-b[0] : a[1]-b[1];
  });
}
// A table's “提示/结论” column heading is not a narrative conclusion. Geometry
// establishes the header band; the same word outside a table remains a heading.
function markTableHeaders(lines: NarrativeOcrLine[]): NarrativeOcrLine[] {
  const label=/^(项目|项目名称|简称|缩写|结果|结论|提示|单位|参考范围|参考区间|参考值)$/;
  const candidates=lines.filter(line=>label.test(line.text.trim()) && Array.isArray(line.box) && line.box.length===4);
  const marked=new Set<NarrativeOcrLine>();
  for(const candidate of candidates) {
    const a=candidate.box as number[];
    const band=candidates.filter(line=>{const b=line.box as number[];return Math.min(a[3],b[3])-Math.max(a[1],b[1])>Math.min(a[3]-a[1],b[3]-b[1])*0.4;});
    const labels=new Set(band.map(line=>line.text.trim()));
    if(labels.size>=3 || (labels.has('项目') || labels.has('项目名称')) && labels.has('结果')) band.forEach(line=>marked.add(line));
  }
  return lines.map(line=>marked.has(line)?{...line,tableHeader:true}:line);
}
// In narrative result tables, item names may be vertically centred beside
// wrapped prose. Move an item before its own complete result only when geometry
// identifies an unambiguous row. Numerical tables keep their existing order.
function tableItemOrder(lines:NarrativeOcrLine[]):NarrativeOcrLine[] {
  const result=[...lines];
  for(const header of lines.filter(line=>line.tableHeader && /^(项目|项目名称)$/.test(line.text.trim()))) {
    const a=header.box as number[];
    const resultHeader=lines.find(line=>line.tableHeader && line.text.trim()==='结果' && Array.isArray(line.box)
      && Math.abs((line.box as number[])[1]-a[1])<4 && (line.box as number[])[0]>a[2]);
    if(!resultHeader) continue;
    const right=(resultHeader.box as number[])[0];
    const limit=lines.filter(line=>Array.isArray(line.box) && Number.isFinite(line.box[1]) && line.box[1]>a[3]
      && (lineHeading(line)||contextHeading(line.text)?.block)).reduce((y,line)=>Math.min(y,(line.box as number[])[1]),Infinity);
    const body=lines.filter(line=>Array.isArray(line.box) && line.box.length===4 && line.box.every(Number.isFinite)
      && line.box[1]>a[3] && line.box[1]<limit && !furniture.test(line.text.trim()));
    const items=body.filter(line=>(line.box as number[])[0]<right-20 && (contextHeading(line.text) || /^[\u4e00-\u9fffA-Za-z0-9+（）() /-]{1,30}$/.test(line.text.trim()) && /[\u4e00-\u9fff]/.test(line.text)));
    const values=body.filter(line=>(line.box as number[])[0]>=right-4);
    if(!items.length || !values.some(line=>line.text.length>20 && /[，。；]/.test(line.text))) continue;
    const runs:NarrativeOcrLine[][]=[];
    for(const line of values) {
      const last=runs.at(-1)?.at(-1), b=line.box as number[],previous=last?.box as number[]|undefined;
      if(!previous || b[1]-previous[1]>Math.min(b[3]-b[1],previous[3]-previous[1])*1.5) runs.push([]);
      runs.at(-1)!.push(line);
    }
    const paired=new Set<NarrativeOcrLine>();
    for(const run of runs) {
      const top=(run[0].box as number[])[1], bottom=(run.at(-1)!.box as number[])[3];
      const matches=items.filter(item=>{const b=item.box as number[],mid=(b[1]+b[3])/2;return mid>=top-2 && mid<=bottom+2;});
      if(matches.length!==1 || paired.has(matches[0])) continue;
      const item=matches[0];paired.add(item);
      result.splice(result.indexOf(item),1);result.splice(result.indexOf(run[0]),0,{...item,tableItem:true});
    }
  }
  return result;
}
// A pair of aligned section headings establishes independent columns. Keep the
// OCR order inside each column; do not join text across the gutter.
function readingOrder(lines: NarrativeOcrLine[]): NarrativeOcrLine[] {
  const titled=lines.flatMap(line=>!line.tableHeader && lineHeading(line) && Array.isArray(line.box) && line.box.length===4
    ? [{line,box:line.box as number[]}] : []);
  for(const left of titled) for(const right of titled) {
    const a=left.box,b=right.box;
    if(b[0]<=a[2]+40 || Math.min(a[3],b[3])-Math.max(a[1],b[1])<=Math.min(a[3]-a[1],b[3]-b[1])*0.4) continue;
    const cut=(a[2]+b[0])/2;
    const columns=[[],[]] as NarrativeOcrLine[][];
    for(const line of lines) {
      const box=line.box as number[]|undefined;
      const column=Array.isArray(box) && box.length===4 && (box[0]+box[2])/2>cut ? 1 : 0;
      columns[column].push(line);
    }
    // Only link a numbered problem/advice table when every source row has an
    // aligned advice cell. Unclear layouts retain their original unlinked text.
    if(lineHeading(left.line)?.field==='summary' && lineHeading(right.line)?.field==='recommendation') {
      const starts=columns[0].filter(line=>/^\s*\d+[、.．]/.test(line.text) && Array.isArray(line.box) && Number.isFinite(line.box[1]) && line.box[1]>a[3]);
      const rows=starts.map((start,index)=>{
        const top=(start.box as number[])[1], bottom=index+1<starts.length?(starts[index+1].box as number[])[1]:Infinity;
        const within=(line:NarrativeOcrLine)=>Array.isArray(line.box) && Number.isFinite(line.box[1]) && line.box[1]>=top-2 && line.box[1]<bottom-2;
        return {issue:columns[0].filter(within).filter(line=>!furniture.test(line.text.trim())).map(line=>line.text).join('\n'),advice:columns[1].filter(within)};
      });
      if(rows.length>=2 && rows.every((row,index)=>Number(/^\s*(\d+)/.exec(starts[index].text)?.[1])===index+1 && row.advice.length && Math.abs((row.advice[0].box as number[])[1]-(starts[index].box as number[])[1])<12)) {
        for(const row of rows) {
          const index=columns[1].indexOf(row.advice[0]);
          columns[1][index]={...columns[1][index],relatedIssue:row.issue};
        }
      }
    }
    const common=[...new Set(lines.filter(line=>{
      const box=line.box as number[]|undefined;
      return /^检查(?:项目|名称)[:：]/.test(line.text.trim()) && Array.isArray(box) && box[1]<Math.min(a[1],b[1]);
    }).map(line=>line.sourceContext?.title || contextHeading(line.text)?.title).filter(Boolean))];
    const titles=[...new Set(lines.filter(line=>Array.isArray(line.box) && (line.box as number[])[1]<Math.min(a[1],b[1]))
      .map(line=>reportContext(sourceReportTitle(line.text))).filter(Boolean))];
    const shared=common.length===1?common[0]:common.length===0&&titles.length===1?titles[0]:undefined;
    if(columns[1].length) columns[1][0]={...columns[1][0],sourceBreak:true,...(shared?{columnContext:shared}:{})};
    return columns.flat();
  }
  return lines;
}
export function collectOriginalNarrativeSections(pages: NarrativeOcrPage[], references: NarrativeSectionReference[] = []) {
  const sections: OriginalNarrativeSection[] = [];
  let active: {field:OriginalNarrativeField;title:string;relatedIssue?:string} | null = null;
  let sectionTitle='';
  let combinedAdvice=false;
  let activeFromHeading=false;
  let department='';
  let blockContext='';
  let tableContext=false;
  let documentTitle='';
  let historyContext='';
  let inEducation=false;
  const seenPages = new Set<string>();
  const headerPages=new Map<string,Set<number>>();
  for(const page of pages) for(const line of page.lines.slice(0,2)) {
    const text=line.text.trim();
    if(/^\d{4}[-/]/.test(text) || text.length>=80 || /[，。；：:]|建议|请|复查|随访/.test(text) || !/(?:报告|体检表|检查单|医院|中心)$/.test(text) || heading(text)) continue;
    const occurrences=headerPages.get(text) || new Set<number>();occurrences.add(page.pageNumber);headerPages.set(text,occurrences);
  }
  for (const page of [...pages].sort((a,b)=>a.pageNumber-b.pageNumber)) {
    if(page.lines.some(line=>/^目\s*录(?:\s*Contents)?$/i.test(line.text.trim()))) {
      active=null;activeFromHeading=false;department='';blockContext='';historyContext='';inEducation=false;combinedAdvice=false;continue;
    }
    const seenIds = new Set<string>();
    const seenBoxes = new Set<string>();
    const reportTitles=new Set(page.lines.slice(0,2).filter(line=>
      !lineHeading(line) && !/[，。；：:]|建议|请|复查|随访/.test(line.text)
      && /^[^\n]{2,60}(?:报告|体检表|检查单)$/.test(line.text.trim())).map(line=>line.text));
    let lines = readingOrder(markTableHeaders(sourceLayout(spatialOrder(page.lines)))).filter(line => {
      if(reportTitles.has(line.text)) return false;
      if((headerPages.get(line.text.trim())?.size || 0)>1) return false;
      if (!line.text.trim() || furniture.test(line.text.trim()) && !sectionFooter.test(line.text.trim())) return false;
      if (line.id && seenIds.has(line.id)) return false;
      if (line.id) seenIds.add(line.id);
      const boxKey = Array.isArray(line.box) && line.box.length === 4 ? `${line.text}:${line.box.join(',')}` : null;
      if (boxKey && seenBoxes.has(boxKey)) return false;
      if (boxKey) seenBoxes.add(boxKey);
      return true;
    });
    const sourceLines=lines;
    lines=tableItemOrder(lines);
    const pageKey = lines.map(line=>key(line.text)).join('\n');
    if (pageKey.length >= 80 && seenPages.has(pageKey)) continue;
    seenPages.add(pageKey);
    if([...reportTitles].some(title=>(headerPages.get(title.trim())?.size || 0)<2)){active=null;activeFromHeading=false;department='';blockContext='';inEducation=false;}
    if([...reportTitles].some(title=>/分项报告|检查报告|检验报告/.test(title))) inEducation=false;
    const newTitle=[...reportTitles].find(title=>! /^(?:分项报告|检验报告|检查报告)$/.test(title.trim()));
    if(newTitle && documentTitle!==newTitle.replace(/\s+/g,'')) {
      documentTitle=newTitle.replace(/\s+/g,'');department=reportContext(newTitle);blockContext=department;historyContext='';
      active=null;activeFromHeading=false;tableContext=false;
    }
    // A new subreport starts before its patient/header rows, even when the
    // OCR emits those rows before the report title itself.
    const firstBody=lines.findIndex(line=>lineHeading(line));
    const pageReport=lines.slice(0,firstBody<0?lines.length:firstBody).map(line=>sourceReportTitle(line.text)).find(Boolean);
    if(pageReport && documentTitle!==pageReport.replace(/\s+/g,'')) {
      documentTitle=pageReport.replace(/\s+/g,'');department=reportContext(pageReport);blockContext=department;historyContext='';
      active=null;activeFromHeading=false;tableContext=false;inEducation=false;
    }
    const educationIndex=lines.findIndex(line=>/^(医学科普|健康科普|疾病知识|检后科普|专家健康宣教|健康宣教)(?:\s*[A-Za-z].*)?$/.test(line.text.trim()));
    if(educationIndex>=0 && educationIndex<8 && (firstBody<0 || educationIndex<firstBody)) {
      active=null;activeFromHeading=false;department='';blockContext='';historyContext='';
    }
    const excluded=new Set<number>();
    for(const [index,line]of lines.entries()) {
      if(/^(医学科普|健康科普|疾病知识|检后科普|专家健康宣教|健康宣教)(?:\s*[A-Za-z].*)?$/.test(line.text.trim())) inEducation=true;
      else if(sourceReportTitle(line.text) || /^分项报告$/.test(line.text.trim())) inEducation=false;
      if(inEducation) excluded.add(index);
    }
    const spans = references.filter(ref=>ref.pageNumber===page.pageNumber).flatMap(ref=>{
      let start=uniqueIndex(lines,ref.startQuote), end=uniqueIndex(lines,ref.endQuote,true);
      if(start<0 || end<start) {
        // References from a cached AI pass may quote the original PDF cell
        // order. Resolve that source range before applying row display order.
        const from=uniqueIndex(sourceLines,ref.startQuote),to=uniqueIndex(sourceLines,ref.endQuote,true);
        if(from<0 || to<from) return [];
        const identity=(line:NarrativeOcrLine)=>line.id || JSON.stringify([line.text,line.box]);
        const selected=new Set(sourceLines.slice(from,to+1).map(identity));
        const indices=lines.flatMap((line,index)=>selected.has(identity(line))?[index]:[]);
        if(!indices.length) return [];
        start=Math.min(...indices);end=Math.max(...indices);
      }
      const separators=lines.slice(start,end+1).some((line,offset)=>line.tableHeader || excluded.has(start+offset)
        || line.sourceBreak && offset>0 || line.tableItem || isBoundary(line.text) || lineHeading(line)?.field && lineHeading(line)?.field!==ref.field);
      if(!separators) return [{...ref,start,end}];
      // A coarse AI page span can cover several departments. Split at actual
      // OCR boundaries, keeping separate findings and never swallowing summaries.
      const chunks:Array<typeof ref & {start:number;end:number}>=[];
      let begin=start, allowed=true;
      const flush=(last:number)=>{
        const part=lines.slice(begin,last+1);
        if(allowed && part.length && (part.length>1 || part[0].text.length>=20 || lines[begin-1]?.tableItem)) chunks.push({...ref,start:begin,end:last});
      };
      for(let index=start;index<=end;index++) {
        const line=lines[index],h=line.tableHeader?null:lineHeading(line);
        if(excluded.has(index)||line.tableHeader||line.tableItem||isBoundary(line.text)||line.sourceBreak||h) {
          flush(index-1);begin=index+1;
          if(h) allowed=h.field===ref.field;
          else if(!line.tableHeader && !excluded.has(index)) allowed=true;
          if(excluded.has(index)) allowed=false;
        }
      }
      flush(end);return chunks;
    });
    let current: OriginalNarrativeSection | null = null;
    let pageBodyStarted=Boolean(active);
    for (const [index,line] of lines.entries()) {
      if(line.sourceBreak){pageBodyStarted=false;active=null;activeFromHeading=false;current=null;department=line.columnContext||'';blockContext=department;tableContext=false;}
      if(excluded.has(index)){active=null;activeFromHeading=false;current=null;continue;}
      const raw=line.text.trim();
      const reportTitle=sourceReportTitle(raw);
      if(reportTitle && !/^(?:分项报告|检验报告)$/.test(reportTitle.replace(/\s+/g,''))) {
        if(documentTitle!==reportTitle.replace(/\s+/g,'')) {
          documentTitle=reportTitle.replace(/\s+/g,'');historyContext='';department=reportContext(raw);blockContext=department;
          active=null;activeFromHeading=false;current=null;tableContext=false;combinedAdvice=false;
        }
        continue;
      }
      if(/^历史(?:检查|体检)(?:结果|报告)(?:[（(]\d+[）)])?[:：]?$/.test(raw)) {
        historyContext=raw;active=null;activeFromHeading=false;current=null;continue;
      }
      if(historyContext && !active && !/\d{4}[-/]/.test(historyContext)) {
        const date=/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.exec(raw);
        if(date) {historyContext+=` · ${date[0]}`;continue;}
      }
      if(sectionFooter.test(raw)) {
        if(!pageBodyStarted) continue;
        active=null;activeFromHeading=false;current=null;department='';blockContext='';tableContext=false;documentTitle='';historyContext='';combinedAdvice=false;continue;
      }
      if(line.contextValue) continue;
      const explicit=line.tableHeader ? null : lineHeading(line) || (/^检查结果[:：]?$/.test(raw) && /心电图/.test(department)?{field:'impression' as const,title:'检查结果',inlineContent:false}:null);
      const context=line.tableHeader ? null : line.sourceContext || (line.tableItem?{title:line.text.trim(),kind:'exam' as const,block:false}:contextHeading(line.text));
      const assigned=spans.filter(span=>span.start<=index && span.end>=index);
      const fields=new Set(assigned.map(span=>span.field));
      const span = fields.size===1 ? assigned[0] : undefined;
      if (explicit) {
        sectionTitle=explicit.title;
        combinedAdvice=/^(?:异常结果与健康建议|本次体检的异常结果汇总及建议)$/.test(explicit.title);
        if(tableContext) department=blockContext;
        tableContext=false;
        // A qualified title (e.g. 呼吸内科小结) supplies its own context and must
        // not inherit the preceding department.
        const qualified=explicit.title.replace(/(?:检查所见|检查结论|小结|结论|所见|建议|概述)$/,'');
        const ownContext=qualified!==explicit.title?contextHeading(qualified):null;
        if(ownContext) {department=ownContext.title;blockContext=department;}
        active={...explicit,title:department && !explicit.title.startsWith(department)?`${department} · ${explicit.title}`:explicit.title};activeFromHeading=true;current=null;
      } else if(context) {
        tableContext=Boolean(line.tableItem);
        const contextTitle=context.kind==='department' && reportContext(documentTitle) && !context.title.includes(reportContext(documentTitle))?`${reportContext(documentTitle)} · ${context.title}`:context.title;
        const retained=!line.sourceContext && !line.tableItem && !context.block && context.kind==='exam' && department.includes(context.title)?department:contextTitle;
        department=line.tableItem && blockContext && blockContext!==context.title?`${blockContext} · ${context.title}`:retained;current=null;
        if(!line.tableItem && (!activeFromHeading || context.kind==='department' || context.block)) blockContext=department;
        if(active && activeFromHeading && (combinedAdvice || active.field!=='recommendation' && context.kind==='exam' && !context.block)) {
          active.title=`${department} · ${sectionTitle}`;
        } else {active=null;activeFromHeading=false;}
        continue;
      } else if (line.tableHeader || isBoundary(line.text)) {
        combinedAdvice=false;active=null;activeFromHeading=false;current=null;continue;
      }
      else if (span && !activeFromHeading) {
        if (index===span.start) current=null;
        active={field:span.field,title:department};
      } else if (assigned.length && !activeFromHeading) {active=null;current=null;continue;}
      if (!active) continue;
      pageBodyStarted=true;
      if(line.relatedIssue && active.field==='recommendation') {current=null;active={...active,relatedIssue:line.relatedIssue};}
      if (!current) {current={...active,title:historyContext?`${historyContext} · ${active.title}`:active.title,pageNumber:page.pageNumber,lines:[]};sections.push(current);}
      current.lines.push(line);
      if (span && !activeFromHeading && index===span.end) {active=null;current=null;}
    }
  }
  // Remove only a contiguous overlap across adjacent pages of the same section.
  for(let index=1;index<sections.length;index++) {
    const previous=sections[index-1], current=sections[index];
    if(previous.field!==current.field || previous.title!==current.title || previous.relatedIssue!==current.relatedIssue || current.pageNumber!==previous.pageNumber+1) continue;
    const offset=current.lines[0] && lineHeading(current.lines[0]) ? 1 : 0;
    for(let count=Math.min(previous.lines.length,current.lines.length-offset);count>0;count--) {
      const suffix=previous.lines.slice(-count).map(line=>key(line.text)).join('\n');
      const prefix=current.lines.slice(offset,offset+count).map(line=>key(line.text)).join('\n');
      if(suffix===prefix && (count>=2 || suffix.length>=30)) {current.lines.splice(offset,count);break;}
    }
  }
  return sections.filter(section=>section.lines.some(line=>{const h=lineHeading(line);return !h || h.inlineContent;}));
}
export function originalNarrativeFieldsFromSections(sections: OriginalNarrativeSection[]) {
  return Object.fromEntries(originalNarrativeFields.map(field=>[field,sections.filter(section=>section.field===field)
    .map(section=>`【第 ${section.pageNumber} 页${section.title ? ` · ${section.title}` : ''}】\n${section.relatedIssue?`对应问题：${section.relatedIssue}\n\n`:''}${section.lines.map(line=>line.text).join('\n')}`).join('\n\n') || null])) as Record<OriginalNarrativeField,string|null>;
}
