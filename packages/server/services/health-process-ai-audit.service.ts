import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { memberAccessSql } from './member.service';
import type { AiRuntimeResponse } from './ai-runtime.service';

export const processAiAuditAction='ai.health_process_summary';
type AuditStatus='processing'|'completed'|'failed'|'cancelled';
type Usage=Partial<Pick<AiRuntimeResponse,'promptTokens'|'completionTokens'|'elapsedMs'>>;

/** Store execution metadata only. Inputs, responses and clinical titles never enter this log. */
export function startProcessAiAudit(user:RequestUser,processId:string,settings:{provider:string;model:string},trigger:'manual'|'automatic'){
  const db=getDatabase();const id=createId('process-ai');const started=Date.now();
  db.prepare(`UPDATE audit_logs SET detail_json=json_set(detail_json,'$.status','failed','$.errorCode','AI_PROCESS_INTERRUPTED',
    '$.errorMessage','整理已中断，请重试','$.finishedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE action=? AND target_id=? AND json_extract(detail_json,'$.status')='processing'`).run(processAiAuditAction,processId);
  const detail={status:'processing' as AuditStatus,attempts:0,provider:settings.provider,model:settings.model,trigger,
    promptTokens:null as number|null,completionTokens:null as number|null,elapsedMs:null as number|null,inputCharacters:0,
    errorCode:null as string|null,errorMessage:null as string|null,finishedAt:null as string|null,applied:false};
  const write=()=>db.prepare('UPDATE audit_logs SET detail_json=? WHERE id=?').run(JSON.stringify(detail),id);
  db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,'health_record_process',?,?)`)
    .run(id,user.id,processAiAuditAction,processId,JSON.stringify(detail));
  const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  return {
    called(inputCharacters:number){detail.attempts=1;detail.inputCharacters=inputCharacters;write();},
    usage(result:Usage){detail.promptTokens=numeric(result.promptTokens);detail.completionTokens=numeric(result.completionTokens);detail.elapsedMs=numeric(result.elapsedMs);},
    finish(status:Exclude<AuditStatus,'processing'>,errorCode:string|null=null){
      detail.status=status;detail.errorCode=errorCode;detail.applied=status==='completed';detail.finishedAt=new Date().toISOString();
      detail.elapsedMs??=Date.now()-started;
      detail.errorMessage=status==='failed'?'健康历程整理失败，原始记录不受影响，可重试':status==='cancelled'?'记录已变化，本次结果未应用':null;
      write();
    }
  };
}

/** The current process owner determines access, including after member merges. */
export function processAiAuditRowsSql(user:RequestUser){return `
  SELECT a.id,'health_process_summary' AS source,NULL AS reportId,
    COALESCE(NULLIF(p.title_override,''),json_extract(p.ai_json,'$.title'),'健康历程整理') AS reportTitle,p.member_id AS memberId,
    CASE WHEN json_extract(a.detail_json,'$.status')='processing' AND p.ai_status<>'pending' THEN 'failed' ELSE json_extract(a.detail_json,'$.status') END AS status,
    COALESCE(json_extract(a.detail_json,'$.attempts'),0) AS attempts,
    CASE WHEN json_extract(a.detail_json,'$.status')='processing' AND p.ai_status<>'pending' THEN 'AI_PROCESS_INTERRUPTED' ELSE json_extract(a.detail_json,'$.errorCode') END AS errorCode,
    CASE WHEN json_extract(a.detail_json,'$.status')='processing' AND p.ai_status<>'pending' THEN '整理已中断，请重试' ELSE json_extract(a.detail_json,'$.errorMessage') END AS errorMessage,
    a.created_at AS createdAt,a.created_at AS startedAt,json_extract(a.detail_json,'$.finishedAt') AS finishedAt,
    json_extract(a.detail_json,'$.provider') AS provider,json_extract(a.detail_json,'$.model') AS model,
    json_extract(a.detail_json,'$.promptTokens') AS promptTokens,json_extract(a.detail_json,'$.completionTokens') AS completionTokens,
    json_extract(a.detail_json,'$.elapsedMs') AS elapsedMs,json_extract(a.detail_json,'$.inputCharacters') AS inputCharacters,
    NULL AS documentContentType,NULL AS routedContentTypes
  FROM audit_logs a JOIN health_record_processes p ON p.id=a.target_id
  WHERE a.action='${processAiAuditAction}' AND ${memberAccessSql(user,'p.member_id')}
`;}
