import { healthCategories, healthSubtypeOptions, isHealthCategory, type HealthCategory } from '../../../shared/health-categories';
export const healthRecordStatusLabels:Record<string,string>={needs_review:'待确认资料',processing:'处理中资料',failed:'识别失败资料',active:'正在跟踪或使用'};
export function healthRecordFilters(query:Record<string,unknown>) {
  const text=(key:string)=>typeof query[key]==='string'?query[key] as string:'';
  let category:HealthCategory|''=isHealthCategory(text('category'))?text('category') as HealthCategory:'';
  let subtype=text('subtype');
  if(!category&&subtype)category=healthCategories.find(type=>healthSubtypeOptions[type].some(([value])=>value===subtype))||'';
  if(!category||!healthSubtypeOptions[category].some(([value])=>value===subtype))subtype='';
  const status=Object.prototype.hasOwnProperty.call(healthRecordStatusLabels,text('status'))?text('status'):'';
  return {category,subtype,status,search:text('q').trim().slice(0,200)};
}
