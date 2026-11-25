import type {AiObservation} from './ai-extraction.service';
type Line={id?:string;text:string;confidence?:number;box?:number[][]};
const compact=(text:string)=>text.normalize('NFKC').replace(/\s/g,'');
const diameterNames:Record<string,[string|null,string,string]>={
 '主动脉':['cardiac_aortic_diameter_unspecified','主动脉内径（部位未注明）','aorta'],
 '升主动脉':['cardiac_ascending_aorta_diameter','升主动脉内径','ascending_aorta'],
 '左房':['cardiac_la_diameter_unspecified','左房内径（径线未注明）','left_atrium'],
 '右房':['cardiac_ra_diameter_unspecified','右房内径（径线未注明）','right_atrium'],
 '右室':['cardiac_rv_diameter_unspecified','右室内径（径线未注明）','right_ventricle'],
 '右室常规':[null,'右室常规内径（口径未明确）','right_ventricle'],
 '左室舒张末':['cardiac_lvidd','左室舒张末期内径','left_ventricle'],
 '左室收缩末':['cardiac_lvids','左室收缩末期内径','left_ventricle'],
 '室间隔':['cardiac_ivst','室间隔厚度','interventricular_septum'],
 '左室后壁':['cardiac_lvpw','左室后壁厚度','left_ventricular_posterior_wall'],
 '主肺动脉':['cardiac_mpa_diameter','主肺动脉内径','main_pulmonary_artery']
};
/** Narrow, source-checked grid supplement. It never replaces the narrative/AI flow. */
export function parseCardiacUltrasoundPage(lines:Line[],pageNumber:number):AiObservation[]{
 const text=lines.map(l=>l.text).join('\n');
 if(!/(?:心脏|心血管).{0,10}(?:彩色)?超声/.test(text) || !/管内径.*mm/i.test(text) || !/瓣口血流/.test(text))return [];
 const cells=lines.flatMap(line=>line.box?.length===4 && line.box.every(p=>p.length>=2 && p.slice(0,2).every(Number.isFinite))?[{...line,x:line.box.reduce((a,p)=>a+p[0],0)/4,y:line.box.reduce((a,p)=>a+p[1],0)/4,h:Math.max(1,Math.abs(line.box[2][1]-line.box[0][1]))}]:[]);
 const headers=cells.filter(c=>/心[腔脏].*大血/.test(c.text)),flows=cells.filter(c=>/瓣口血流/.test(c.text));
 if(headers.length!==1 || flows.length!==1)return [];
 const header=headers[0],flow=flows[0];
 if(!header || !flow || header.y>=flow.y)return [];
 const observations:AiObservation[]=[];const seen=new Set<string>();
 function push(key:string|null,name:string,site:string,raw:string,unit:string,sources:Line[],method:string|null=null){
  if(sources.some(c=>(c.confidence??1)<.85) || !Number.isFinite(Number(raw)) || Number(raw)<=0)return;
  const identity=`${name}:${method || ''}`;if(seen.has(identity)){for(let i=observations.length-1;i>=0;i--)if(observations[i].itemName===name && observations[i].method===method)observations.splice(i,1);return;}seen.add(identity);
  observations.push({sectionName:'心脏超声测量',itemCode:key,itemName:name,normalizedName:key?name:null,resultText:raw,numericValue:Number(raw),unit,referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null,
   examinationModality:'超声心动图',measurementSite:site,measurementLaterality:'unspecified',method,
   evidence:[{pageNumber,quote:`${name} | ${raw} ${unit}`,table:{headerText:sources[0].text,headerSourceLineIds:sources[0].id?[sources[0].id]:[],rowSourceLineIds:sources.slice(1).flatMap(c=>c.id?[c.id]:[]),resultColumn:{index:1,headerText:'测量值',selectionBasis:'local_source_map'}}}]});
 }
 const grid=cells.filter(c=>c.y>=header.y-header.h && c.y<flow.y-flow.h*.55);
 for(const cell of grid){
  const full=compact(cell.text),merged=full.match(/^(.+?)(\d+(?:\.\d+)?)(?:mm)?$/i);
  const label=merged?.[1] || full,definition=diameterNames[label];if(!definition)continue;
  const right=grid.filter(other=>other!==cell && other.x>cell.x && Math.abs(other.y-cell.y)<Math.max(cell.h,other.h)*.65).sort((a,b)=>a.x-b.x)[0];
  const value=merged?.[2] || (right && right.x-cell.x<cell.h*8 && /^\d+(?:\.\d+)?$/.test(compact(right.text))?compact(right.text):null);
  if(value)push(definition[0],definition[1],definition[2],value,'mm',[header,cell,...(!merged && right?[right]:[])]);
 }
 const description=cells.find(c=>/超声描述/.test(c.text));const bottom=description?.y ?? flow.y+flow.h*9;
 const valves=cells.filter(c=>c.y>=flow.y-flow.h && c.y<flow.y+flow.h && /^(二尖瓣|三尖瓣|主动脉瓣|肺动脉瓣)$/.test(compact(c.text))).sort((a,b)=>a.x-b.x);
 const flowUnit=cells.some(c=>c.y>=flow.y-flow.h && c.y<flow.y+flow.h*2 && /m\/s/i.test(c.text) && !/cm\/s/i.test(c.text));
 if(valves.length===4 && flowUnit)for(const [index,valve] of valves.entries()){
  const start=index? (valves[index-1].x+valve.x)/2:valve.x-valve.h*2;
  const end=index<valves.length-1?(valve.x+valves[index+1].x)/2:valve.x+valve.h*4.5;
  const region=cells.filter(c=>c.y>valve.y+valve.h*.7 && c.y<bottom && c.x>start && c.x<end);
  const label=compact(valve.text);const atrioventricular=label==='二尖瓣'||label==='三尖瓣';
  for(const value of region.filter(c=>/^\d+(?:\.\d+)?$/.test(compact(c.text)))){
   const prefix=region.filter(c=>/^[EA]$/.test(compact(c.text)) && c.x<value.x && Math.abs(c.y-value.y)<Math.max(c.h,value.h)*.65);
   if(atrioventricular && prefix.length!==1)continue;
   if(!atrioventricular && region.filter(c=>/^\d+(?:\.\d+)?$/.test(compact(c.text))).length!==1)continue;
   const wave=atrioventricular?compact(prefix[0].text).toLowerCase():null;
   const stem=label==='二尖瓣'?'mitral':label==='三尖瓣'?'tricuspid':label==='主动脉瓣'?'aortic_valve':'pulmonary_valve';
   push(`cardiac_${stem}${wave?'_'+wave:''}_velocity`,`${label}${wave?' '+wave.toUpperCase()+' 波':''}血流速度`,stem==='mitral'?'mitral_valve':stem==='tricuspid'?'tricuspid_valve':stem,compact(value.text),'m/s',[valve,...prefix,value]);
  }
 }
 const ef=cells.filter(c=>/^LVEF$/i.test(compact(c.text)) && c.y>flow.y && c.y<bottom);
 if(ef.length===1){const values=cells.filter(c=>c.x>ef[0].x && Math.abs(c.y-ef[0].y)<Math.max(c.h,ef[0].h)*.65 && /^\d+(?:\.\d+)?%$/.test(compact(c.text)));if(values.length===1)push('cardiac_lvef','左室射血分数','left_ventricle',compact(values[0].text).replace('%',''),'%', [ef[0],values[0]]);}
 for(const line of cells.filter(c=>/组织多普勒.*二尖瓣环.*室间隔/.test(c.text))){
  for(const match of compact(line.text).matchAll(/([SEA])['’′](\d+(?:\.\d+)?)cm\/s/gi)){
   const wave=match[1].toUpperCase();push(`cardiac_mitral_annulus_septal_${wave.toLowerCase()}_velocity`,`二尖瓣环室间隔侧 ${wave}′ 组织速度`,'mitral_annulus_septal',match[2],'cm/s',[line,line],'组织多普勒');
  }
 }
 return observations;
}
