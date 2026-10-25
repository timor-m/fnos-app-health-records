import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { memberAccessSql } from './member.service';
import { specificProcessTitle } from './health-process-title';
import { untitledHealthProcessTitle } from '../../shared/health-process';

type AuditRow = { action:string;targetType:string|null;targetId:string|null;detailJson:string };
type Ref = { kind:string;id:string };
export const healthAuditTargetLabels:Record<string,string> = {
  report:'报告',symptom:'症状记录',medication:'用药记录',intake:'服药补充',vaccination:'接种记录',
  event:'资料分组',episode:'症状记录',process:'健康历程'
};
export function readUserAuditDetail(json:string):Record<string,unknown> {
  try {const value:unknown=JSON.parse(json);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
  catch {return {};}
}
function ref(kind:unknown,id:unknown):Ref|null {
  if(kind==='medication_document')kind='report';
  return typeof kind==='string'&&Object.hasOwn(healthAuditTargetLabels,kind)&&typeof id==='string'&&id?{kind,id}:null;
}
function targetRef(row:AuditRow):Ref|null {
  const detail=readUserAuditDetail(row.detailJson);
  if(row.targetType==='health_record')return ref(detail.kind,row.targetId);
  if(row.targetType==='medication'&&row.action.startsWith('medication.intake.'))return ref('intake',row.targetId);
  if(row.targetType==='health_episode'&&typeof detail.symptomId==='string')return ref('symptom',detail.symptomId);
  const aliases:Record<string,string>={health_event:'event',health_episode:'episode',health_record_process:'process'};
  const kind=aliases[row.targetType||'']||row.targetType;
  return ref(kind,row.targetId);
}
/** Resolve current names at read time; never copy clinical names into persisted audit details. */
export function loadHealthUserAuditTargets(user:RequestUser,rows:AuditRow[]) {
  const refs=new Map<string,Set<string>>();
  for(const row of rows){const value=targetRef(row);if(value){const ids=refs.get(value.kind)||new Set<string>();ids.add(value.id);refs.set(value.kind,ids);}}
  const names=new Map<string,string>();
  const sources:Record<string,{table:string;name:string;member:string;join?:string}>={
    report:{table:'reports',name:'r.title',member:'r.member_id'},
    symptom:{table:'health_process_symptoms',name:'r.name',member:'e.member_id',join:'JOIN health_episodes e ON e.id=r.episode_id'},
    medication:{table:'medication_courses',name:'r.medication_name',member:'r.member_id'},
    intake:{table:'medication_intakes',name:'r.medication_name',member:'r.member_id'},
    vaccination:{table:'health_vaccinations',name:'r.vaccine_name',member:'r.member_id'},
    event:{table:'health_events',name:'r.title',member:'r.member_id'},
    episode:{table:'health_episodes',name:'r.title',member:'r.member_id'},
    process:{table:'health_record_processes',name:'COALESCE(r.title_override,(SELECT t.title FROM health_record_process_trash t WHERE t.process_id=r.id AND t.deleted_at IS NOT NULL))',member:'r.member_id'}
  };
  for(const [kind,ids] of refs){
    const source=sources[kind];const placeholders=[...ids].map(()=>'?').join(',');
    const results=getDatabase().prepare(`SELECT r.id,${source.name} AS name${kind==='process'?',r.ai_json AS aiJson':''}
      FROM ${source.table} r ${source.join||''} WHERE r.id IN (${placeholders}) AND ${memberAccessSql(user,source.member)}`)
      .all(...ids) as Array<{id:string;name:string|null;aiJson?:string|null}>;
    for(const result of results){
      const name=kind==='process'?result.name||specificProcessTitle(readUserAuditDetail(result.aiJson||'{}').title)||untitledHealthProcessTitle:result.name;
      if(name)names.set(`${kind}:${result.id}`,name);
    }
  }
  return (row:AuditRow)=>{
    // Existing report targets retain their established resolution outside this helper.
    if(row.targetType==='report')return null;
    const value=targetRef(row);if(!value)return null;
    const label=row.targetType==='health_record'&&readUserAuditDetail(row.detailJson).kind==='medication_document'?'用药单':healthAuditTargetLabels[value.kind];
    return {label,name:names.get(`${value.kind}:${value.id}`)||`${label}（已删除或不可访问）`};
  };
}
