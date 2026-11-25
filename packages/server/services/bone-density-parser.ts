import { boneMetrics, boneSiteLabel, inferBoneSite } from '../../shared/bone-density';
import { parseExaminationTime } from '../domain/examination';
import type { AiObservation } from './ai-extraction.service';

type Line = {id?: string; text: string; box?: number[][]; confidence?: number};
type Cell = Line & {x:number;y:number;h:number};
const compact = (text:string) => text.normalize('NFKC').replace(/\s/g,'').replace(/[−–—]/g,'-');
/** A narrow DXA table reader. Ambiguous layout/method/date stays on the normal extraction path. */
export function parseDxaPage(lines:Line[],pageNumber:number):AiObservation[] | null {
 if(!Array.isArray(lines) || lines.some(line=>!line || typeof line.text!=='string'))return null;
 const text=lines.map(l=>l.text).join('\n');
 if(lines.some(line=>/^(?:检查)?(?:结论|诊断|提示|建议|所见)[:：]\s*\S/.test(line.text)))return null;
 if(!/DXA|双能.*X/i.test(text) || !/T.?值评分/.test(text) || !/Z.?值评分/.test(text))return null;
 const cells:Cell[]=lines.flatMap(line=>Array.isArray(line.box) && line.box.length===4 && line.box.every(point=>Array.isArray(point) && point.length>=2 && point.slice(0,2).every(Number.isFinite)) ? [{...line,x:line.box.reduce((a,p)=>a+p[0],0)/4,y:line.box.reduce((a,p)=>a+p[1],0)/4,h:Math.abs(line.box[2][1]-line.box[0][1])}] : []);
 const header=cells.find(c=>compact(c.text)==='区域');
 const history=cells.find(c=>/骨密度.*趋势/.test(c.text));
 if(!header || !history || header.y>=history.y || header.h<=0)return null;
 const near=cells.filter(c=>c.y<header.y+8 && c.y>header.y-header.h*2.5 && c.x>header.x);
 const bmd=near.find(c=>/g\/cm2/i.test(compact(c.text)));
 const t=near.find(c=>/^T值$/.test(compact(c.text)));
 const z=near.find(c=>/^(?:Z|乙)值$/.test(compact(c.text)));
 if(!bmd || !t || !z || !(header.x<bmd.x && bmd.x<t.x && t.x<z.x))return null;
 const slope=(t.y-header.y)/(t.x-header.x);
 if(Math.abs(slope)>.12)return null;
 const femurContext=lines.filter(line=>!/中轴长度|髋轴长度/.test(line.text)).map(line=>line.text).join('\n');
 const left=/左侧.*(?:股骨|髋)/.test(femurContext),right=/右侧.*(?:股骨|髋)/.test(femurContext);
 if(left&&right)return null;
 const side=left?'left':right?'right':'unspecified';
 const siteOf=(label:string)=>inferBoneSite(label) || (compact(label)==='全部' && (left||right) ? 'femur_total':null);
 const historySite=siteOf(history.text.replace(/^.*趋势[:：]?/,''));
 if(!historySite)return null;
 const dateHeader=cells.find(c=>/测量日期/.test(c.text) && c.y>history.y);
 const hbmd=cells.find(c=>compact(c.text)==='骨密度' && c.y>history.y && (!dateHeader || c.y<dateHeader.y));
 if(!dateHeader || !hbmd)return null;
 const dates=cells.filter(c=>c.y>dateHeader.y && Math.abs(c.x-dateHeader.x)<dateHeader.h*2 && /^\d{2}\/\d{2}\/\d{4}$/.test(compact(c.text)));
 // Establish month/day order from an unambiguous date in this table, never locale guessing.
 if(!dates.length || !dates.some(c=>Number(compact(c.text).split('/')[1])>12) || dates.some(c=>Number(compact(c.text).split('/')[0])>12))return null;
 const numeric=(c:Cell)=>/^-?\d+(?:\.\d+)?$/.test(compact(c.text));
 function valueAt(row:Cell,column:Cell,tableSlope:number, candidates:Cell[], tolerance:number) {
  const matches=candidates.filter(c=>numeric(c) && Math.abs(c.x-column.x)<Math.max(column.h,header!.h)*1.8 && Math.abs(c.y-row.y-tableSlope*(c.x-row.x))<tolerance);
  return matches.length===1 ? matches[0] : null;
 }
 const historyRows=dates.map(date=>{
  const [m,d,y]=compact(date.text).split('/');
  const time=parseExaminationTime(`${y}-${m}-${d}`)?.value;
  const value=valueAt(date,hbmd,(bmd.y-header.y)/(bmd.x-header.x),cells.filter(c=>c.y>dateHeader.y-3),dateHeader.h*.42);
  return time && value ? {date,time,value}:null;
 });
 if(historyRows.some(row=>!row))return null;
 const current=historyRows.filter(row=>!!row).sort((a,b)=>b.time.localeCompare(a.time))[0]!;
 const regionCells=cells.filter(c=>c.y>header.y+header.h*.6 && c.y<history.y-header.h*.5 && Math.abs(c.x-header.x)<header.h*2.6);
 if(!regionCells.length || regionCells.some(c=>!siteOf(c.text)))return null;
 const observations:AiObservation[]=[];
 const used=new Set<Cell>();
 function observation(site:string,metric:typeof boneMetrics[number],value:Cell,date:Cell,time:string,row:Cell) {
  const name=`DXA ${boneSiteLabel(site,site.startsWith('lumbar_')?'unspecified':side)} ${metric.label}`;
  const quote=`${name} | ${value.text} ${metric.unit || ''} | ${date.text}`;
  observations.push({sectionName:'DXA 骨密度',itemCode:metric.key,itemName:`DXA ${boneSiteLabel(site,site.startsWith('lumbar_')?'unspecified':side)} ${metric.label}`,normalizedName:metric.key==='dxa_bmd'?'DXA 骨密度':`DXA ${metric.label}`,resultText:compact(value.text),numericValue:Number(compact(value.text)),unit:metric.unit,referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,method:'DXA',measurementSite:site,measurementLaterality:site.startsWith('lumbar_')?'unspecified':side,examination:{examinationType:'骨密度',method:'DXA',examinedAt:time,timeText:date.text,evidence:[{pageNumber,quote:date.text}]},evidence:[{pageNumber,quote,table:{headerText:'DXA 部位 | 测量值 | 测量日期',headerSourceLineIds:[header!.id,bmd!.id,t!.id,z!.id].filter((id):id is string=>!!id),rowSourceLineIds:[row.id,value.id,date.id].filter((id):id is string=>!!id),resultColumn:{index:1,headerText:metric.label,selectionBasis:'local_source_map'}}}]});
 }
 for(const row of regionCells){
  const site=siteOf(row.text)!;
  if(site.startsWith('femur_') && side==='unspecified')return null;
  for(const [index,column] of [bmd,t,z].entries()){
   const value=valueAt(row,column,slope,cells.filter(c=>c.y>header.y && c.y<history.y-header.h*.5),header.h*.38);
   if(index===0 && !value)return null;
   if(value){if(used.has(value) || (value.confidence !== undefined && value.confidence < .85) || (index===0 && Number(compact(value.text))<=0))return null;used.add(value);observation(site,boneMetrics[index],value,current.date,current.time,row);}
  }
 }
 // Do not silently skip a score that could not be assigned to a unique region.
 if(cells.some(c=>c.y>header.y+header.h*.6 && c.y<history.y-header.h*.5 && (Math.abs(c.x-t.x)<t.h*1.8 || Math.abs(c.x-z.x)<z.h*1.8) && numeric(c) && !used.has(c)))return null;
 const currentBmd=observations.find(o=>o.measurementSite===historySite && o.itemCode==='dxa_bmd');
 if(!currentBmd || currentBmd.numericValue!==Number(compact(current.value.text)))return null;
 for(const row of historyRows){if(row && row.time!==current.time)observation(historySite,boneMetrics[0],row.value,row.date,row.time,history);}
 // HAL uses its own explicit side labels, independently of the BMD table's side.
 const axisHeaders=cells.filter(cell=>/^(?:[左右双]+侧?)?髋关节中轴长度(?:比较)?[（(]mm[）)]$/i.test(cell.text.replace(/\s/g,'')));
 if(axisHeaders.length) {
  if(axisHeaders.length!==1)return null;
  const axisHeader=axisHeaders[0],headerSide=compact(axisHeader.text).match(/^([左右])(?:侧)?髋关节/)?.[1];
  const sourceRows=cells.filter(cell=>cell.y>axisHeader.y && cell.y<axisHeader.y+axisHeader.h*8 && cell.x<header.x
   && Math.abs(cell.x-axisHeader.x)<Math.max(axisHeader.h*2,Math.abs(axisHeader.box![2][0]-axisHeader.box![0][0])));
  // An unqualified/bilateral label cannot establish which side owns a number.
  if(sourceRows.some(cell=>/(?:左右|双侧|双髋|左(?:侧)?[\/、和与]右)/.test(compact(cell.text))))return null;
  const candidates=sourceRows.flatMap(cell=>[...compact(cell.text).matchAll(/([左右])(?:侧)?[=:：]([+]?[0-9]+(?:\.[0-9]+)?)(?:mm|毫米)(?=$|[,，;；]|均值|平均值|左|右)/gi)]
   .filter(match=>!/均值|平均值|参考|标准/.test(compact(cell.text).slice(0,match.index)))
   .map(match=>({cell,side:match[1],value:Number(match[2]),raw:match[2]})));
  if(!candidates.length || new Set(candidates.map(item=>item.side)).size!==candidates.length
   || candidates.some(item=>item.value<=0 || (item.cell.confidence ?? 1)<.85 || (headerSide && headerSide!==item.side)))return null;
  for(const {cell,side:axisSide,value,raw} of candidates){
   const name=`${axisSide}侧髋关节中轴长度`;
   observations.push({sectionName:'骨结构测量',itemCode:null,itemName:name,normalizedName:name,resultText:raw,numericValue:value,unit:'mm',referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,method:'DXA',measurementSite:null,measurementLaterality:axisSide==='左'?'left':'right',
    examination:{examinationType:'骨密度',method:'DXA',examinedAt:current.time,timeText:current.date.text,evidence:[{pageNumber,quote:current.date.text}]},
    evidence:[{pageNumber,quote:`${name} | ${raw} mm | ${current.date.text}`,table:{headerText:axisHeader.text,headerSourceLineIds:axisHeader.id?[axisHeader.id]:[],rowSourceLineIds:[cell.id,current.date.id].filter((id):id is string=>!!id),resultColumn:{index:1,headerText:'实测长度',selectionBasis:'local_source_map'}}}]});
  }
 }
 return observations;
}
