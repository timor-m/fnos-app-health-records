import {measurementDimensions,measurementIndicatorDefinition,type MeasurementDimension,type MeasurementIndicatorDefinition} from './measurement-indicators';
export type MeasurementContext=Partial<Record<MeasurementDimension,string|null>>;
const encode=(value:string)=>value.replace(/%/g,'%25').replace(/@/g,'%40');
export const measurementMethod=(value?:string|null)=>value && !/^(?:ai|ocr|manual)$/i.test(value.trim())?value.normalize('NFKC').trim():null;
function dimensions(definition:MeasurementIndicatorDefinition){return measurementDimensions.filter(dimension=>definition.dimensions.includes(dimension));}
function normalizedContext(context:MeasurementContext,definition:MeasurementIndicatorDefinition){
 const result:Record<MeasurementDimension,string>={measurementSite:context.measurementSite?.trim() || '',measurementLaterality:context.measurementLaterality?.trim() || 'unspecified',examinationModality:context.examinationModality?.trim() || '',method:measurementMethod(context.method)?.toLocaleLowerCase().replace(/\s+/g,'') || ''};
 if(definition.methodAsModality && result.method===definition.methodAsModality.toLocaleLowerCase()){
  if(!result.examinationModality)result.examinationModality=definition.methodAsModality;
  result.method='';
 }
 if(!result.examinationModality)result.examinationModality=definition.defaultModality || '';
 for(const dimension of measurementDimensions)if(!definition.dimensions.includes(dimension))result[dimension]='';
 return result;
}
/** Indicator plus only its declared dimensions. Old codecs are compatibility paths, not domain rules. */
export function measurementTrendIdentity(key:string,context:MeasurementContext={},definition=measurementIndicatorDefinition(key)){
 if(!definition)return key;
 const value=normalizedContext(context,definition);
 if(definition.compatibility==='plain-v1' && value.examinationModality===definition.defaultModality && !value.method)return key;
 if(definition.compatibility==='bone-v1'){
  if(!value.measurementSite || !definition.allowedSites?.includes(value.measurementSite))return key;
  if(value.examinationModality===definition.defaultModality && !value.method)return `${key}@${value.measurementSite}@${value.measurementLaterality}`;
 }
 if(definition.compatibility==='cardiac-v1'){
  if(!value.measurementSite && !value.examinationModality)return key; // Preserve legacy method-only keys and pins.
  if(!value.measurementLaterality || value.measurementLaterality==='unspecified')return [key,'cardiac',value.measurementSite,value.examinationModality,value.method].map(encode).join('@');
 }
 const fields=dimensions(definition);
 if(!fields.some(field=>value[field] && value[field]!=='unspecified'))return key;
 return [key,'measurement',...fields.map(field=>value[field])].map(encode).join('@');
}
export function parseMeasurementSeriesKey(key:string,definition=measurementIndicatorDefinition(key.split('@')[0] || '')){
 if(!definition)return null;
 const parts=key.split('@');const metric=parts[0];
 try{
  let context:MeasurementContext;
  if(definition.compatibility==='bone-v1' && parts.length===3 && definition.allowedSites?.includes(parts[1]) && ['left','right','unspecified'].includes(parts[2])){
   context={measurementSite:parts[1],measurementLaterality:parts[2],examinationModality:definition.defaultModality || null,method:null};
  }else if(definition.compatibility==='cardiac-v1' && parts.length===5 && parts[1]==='cardiac'){
   context={measurementSite:decodeURIComponent(parts[2]),examinationModality:decodeURIComponent(parts[3]),method:decodeURIComponent(parts[4])};
  }else{
   const fields=dimensions(definition);if(parts[1]!=='measurement' || parts.length!==fields.length+2)return null;
   context=Object.fromEntries(fields.map((field,index)=>[field,decodeURIComponent(parts[index+2])])) as MeasurementContext;
  }
  return {metric,context,contextKey:parts.slice(1).join('@'),definition};
 }catch{return null;}
}
export const measurementBaseKey=(key:string)=>parseMeasurementSeriesKey(key)?.metric || key;
