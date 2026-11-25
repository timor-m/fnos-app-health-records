import {measurementIndicatorDefinition} from './measurement-indicators';
import {measurementTrendIdentity,parseMeasurementSeriesKey,measurementMethod} from './measurement-trend-identity';
/** Cardiac measurements only: laboratory markers with a cardiac_ prefix stay unchanged. */
export const cardiacSites = [
 ['aorta','主动脉（部位未注明）'],['aortic_sinus','主动脉窦部'],['ascending_aorta','升主动脉'],
 ['left_atrium','左心房'],['right_atrium','右心房'],['left_ventricle','左心室'],['right_ventricle','右心室'],
 ['interventricular_septum','室间隔'],['left_ventricular_posterior_wall','左室后壁'],['main_pulmonary_artery','主肺动脉'],
 ['mitral_valve','二尖瓣'],['tricuspid_valve','三尖瓣'],['aortic_valve','主动脉瓣'],['pulmonary_valve','肺动脉瓣'],['mitral_annulus_septal','二尖瓣环室间隔侧']
] as const;
export const cardiacModalities=['超声心动图','CT','MRI'] as const;
export const isCardiacMeasurement=(key:string)=>measurementIndicatorDefinition(key)?.presentation==='cardiac';
export const cardiacMethod=measurementMethod;
/** Compatibility adapter for cardiac UI; identity construction is shared. */
export function cardiacSeriesIdentity(key:string,site?:string|null,modality?:string|null,method?:string|null){
 return isCardiacMeasurement(key)?measurementTrendIdentity(key,{measurementSite:site,examinationModality:modality,method}):key;
}
export function parseCardiacSeriesKey(key:string){
 const parsed=parseMeasurementSeriesKey(key);return parsed?.definition.presentation==='cardiac'?{metric:parsed.metric,site:parsed.context.measurementSite || '',modality:parsed.context.examinationModality || '',method:parsed.context.method || ''}:null;
}
export function cardiacContextLabel(modality?:string|null,method?:string|null){return `${modality || '检查方式未注明'} · ${cardiacMethod(method) || '测量方法未注明'}`;}
/** Preserve the hospital's raw label without guessing an anatomical diameter. */
export function unresolvedCardiacMeasurementName(name:string){
 return /^右室常规(?:内径\(口径未明确\))?$/.test(name.normalize('NFKC').replace(/\s/g,''))?'右室常规':null;
}
