/** Bone measurements keep skeletal region and laterality as identity. */
import {boneMeasurementSites,measurementIndicatorDefinition} from './measurement-indicators';
import {measurementTrendIdentity,parseMeasurementSeriesKey} from './measurement-trend-identity';
export const boneSites=boneMeasurementSites;
export const boneMetrics=[{key:'dxa_bmd',label:'BMD',unit:'g/cm²'},{key:'dxa_t_score',label:'T 值',unit:null},{key:'dxa_z_score',label:'Z 值',unit:null}] as const;
export type BoneSide='left'|'right'|'unspecified';
export function boneSiteLabel(site:string,side:string='unspecified') {return `${side==='left'?'左侧':side==='right'?'右侧':''}${boneSites.find(item=>item[0]===site)?.[1] || site}`;}
/** Compatibility adapter for bone UI; identity construction is shared. */
export function boneSeriesIdentity(key:string,site?:string|null,side?:string|null,modality?:string|null,method?:string|null) {
 return measurementIndicatorDefinition(key)?.presentation==='bone'?measurementTrendIdentity(key,{measurementSite:site,measurementLaterality:side,examinationModality:modality,method}):key;
}
export function parseBoneSeriesKey(key:string) {
 const parsed=parseMeasurementSeriesKey(key);
 if(!parsed || parsed.definition.presentation!=='bone')return null;
 const {measurementSite:site,measurementLaterality:side='unspecified',examinationModality:modality='DXA',method}=parsed.context;
 if(!site || !boneSites.some(item=>item[0]===site) || !['left','right','unspecified'].includes(side || ''))return null;
 return {metric:parsed.metric,site,side:side as BoneSide,group:parsed.contextKey,name:`${modality} · ${boneSiteLabel(site,side || 'unspecified')}${method?' · '+method:''}`,context:parsed.context};
}
/** The three metrics belong to one site card for pinning; ordinary keys stay independent. */
export function boneCardMetricKeys(key:string) {
 const bone=parseBoneSeriesKey(key);
 return bone ? boneMetrics.map(metric=>measurementTrendIdentity(metric.key,bone.context)) : null;
}
export function inferBoneSite(text:string):string|null {
 const value=text.normalize('NFKC').replace(/[–—−~～至]/g,'-').replace(/\s/g,'').toUpperCase();
 const lumbar=value.match(/^(?:腰椎L?|L)([1-4])(?:-(?:L)?([1-4]))?$/);
 if(lumbar){const a=Number(lumbar[1]),b=Number(lumbar[2]||a);const site=a===b?`lumbar_l${a}`:`lumbar_l${a}_l${b}`;return boneSites.some(item=>item[0]===site)?site:null;}
 if(/WARDS|WARD['’]?S|三角/.test(value))return 'femur_wards';
 if(/粗隆|转子|轉子/.test(value))return 'femur_trochanter';
 if(/股骨干/.test(value))return 'femur_shaft';
 if(/(?:股骨)?颈上|頸上/.test(value))return 'femur_neck_upper';
 if(/(?:股骨)?颈下|頸下/.test(value))return 'femur_neck_lower';
 if(/股骨颈|股骨頸|^颈$|^頸$|FEMORALNECK/.test(value))return 'femur_neck';
 if(/股骨.*(?:全部|整体|总)|TOTALHIP|TOTALFEMUR|全髋/.test(value))return 'femur_total';
 if(/桡骨|橈骨/.test(value)&&/1\/3|33%/.test(value))return 'radius_33';
 return null;
}
