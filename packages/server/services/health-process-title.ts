import { untitledHealthProcessTitle } from '../../shared/health-process';

// A type list describes storage, not the health matter the user is following.
const genericPrefix=/^(?:(?:健康)?(?:记录|档案|资料|历程|事项)(?:概览|概述|汇总|整理|总结)?|健康概览)\s*[：:]\s*/u;
const genericTypeList=/^(?:(?:健康|医疗)?(?:记录|档案|资料|历程|事项|概览|概述|汇总|整理|总结)|体检(?:报告|记录)?|门诊(?:报告|记录)?|就诊(?:报告|记录)?|检验(?:报告|记录)?|检查(?:报告|记录)?|报告|影像|症状|处方(?:笺|单)?|用药(?:单|记录)?|治疗|疫苗|接种(?:凭证|记录)?|复查|以及|及|与|和|[\s、，,；;：:/／·&+（）()\-])+$/u;

/** Apply the same title quality rules to generated output and cached AI results, never to manual titles. */
export function specificProcessTitle(value:unknown):string|null {
  if(typeof value!=='string')return null;
  let title=value.replace(/\s+/g,' ').trim();
  while(genericPrefix.test(title))title=title.replace(genericPrefix,'').trim();
  if(!title||title===untitledHealthProcessTitle||Array.from(title).length>30||/…|\.{3}/u.test(title))return null;
  return genericTypeList.test(title)?null:title;
}
