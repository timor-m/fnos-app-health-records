import {validateRecordReminder,completeReminderWithRecord} from './health-process-reminder.service';
import {processRecord,processRecordRef,processRecordKey,getRecordProcess,joinRecordProcess,linkProcessRecords} from './health-record-process.service';
import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { HealthUploadContext } from '../../shared/health-upload';
import { assertMemberManage } from './member.service';
import { createHealthEvent } from './health-event.service';
import { textInput } from './health-event-input';

export function validateUploadContext(user: RequestUser, memberId: string, input?: unknown): HealthUploadContext {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input)))
    throw createError({ statusCode: 400, statusMessage: '上传来源信息无效' });
  assertMemberManage(user,memberId);
  const fields = (input || {}) as Record<string, unknown>;
  const processId=textInput(fields.processId,'健康历程',100);
  if(processId&&getRecordProcess(user,processId).memberId!==memberId)throw createError({statusCode:403,statusMessage:'只能加入当前成员的健康历程'});
  const reminderId=textInput(fields.reminderId,'复查提醒',100);
  const reminder=reminderId?validateRecordReminder(user,reminderId,memberId):null;
  const source=fields.relatedRecord??reminder?.relatedRecord;
  const related=source?processRecord(user,processRecordRef(source)):null;
  if(related&&related.memberId!==memberId)throw createError({statusCode:403,statusMessage:'只能关联当前成员的记录'});
  if(reminder?.relatedRecord&&related&&processRecordKey(reminder.relatedRecord)!==processRecordKey(related.ref))
    throw createError({statusCode:409,statusMessage:'所选记录与复查提醒来源不一致'});
  if(processId&&reminder?.processes.some(process=>process.id!==processId))throw createError({statusCode:409,statusMessage:'所选健康历程与复查提醒来源不一致'});
  return {...(processId?{processId}:{}),...(related?{relatedRecord:related.ref}:{}),...(reminderId?{reminderId}:{})};
}

/** The upload owns the transaction, so a failed association also rolls back its report. */
export function registerUploadedReport(user: RequestUser, memberId: string, reportId: string, input: HealthUploadContext) {
  const context = validateUploadContext(user, memberId, input);
  if(context.processId)joinRecordProcess(user,context.processId,memberId,[{kind:'report',id:reportId}]);
  else if(context.relatedRecord)linkProcessRecords(user,{kind:'report',id:reportId},[context.relatedRecord]);
  if(context.reminderId)completeReminderWithRecord(user,context.reminderId,memberId,{kind:'report',id:reportId});
  getDatabase().prepare(`INSERT INTO health_upload_items(report_id,context_json,state) VALUES(?,?,'pending')`)
    .run(reportId,JSON.stringify(context));
  return {workflowStatus:'pending' as const};
}

function reportIdsInput(input: unknown, maximum = 100) {
  if (!Array.isArray(input) || input.length > maximum || input.some(id => typeof id !== 'string' || !id || id.length > 100)
    || new Set(input).size !== input.length) throw createError({statusCode:400,statusMessage:'资料列表无效'});
  return input as string[];
}

type ReportRow = { id:string; title:string; status:string; reportType:string; reportIssuedAt:string|null;
  organizationName:string|null; department:string|null; state:string|null; eventId:string|null };
function readReport(user: RequestUser, memberId: string, reportId: string) {
  const row = getDatabase().prepare(`SELECT r.id,r.title,r.status,r.report_type AS reportType,
    COALESCE(r.report_issued_at,r.reviewed_at,r.received_at,r.examined_at,r.sampled_at,r.ordered_at) AS reportIssuedAt,r.hospital_name_raw AS organizationName,
    COALESCE(r.visit_department,r.performing_department,r.reporting_department) AS department,
    u.state,u.event_id AS eventId
    FROM reports r LEFT JOIN health_upload_items u ON u.report_id=r.id
    WHERE r.id=? AND r.member_id=? AND r.status<>'trashed'`).get(reportId, memberId) as ReportRow|undefined;
  if (!row) throw createError({statusCode:404,statusMessage:'资料不存在或不属于当前成员'});
  return row;
}

function documentGroupType(type:string){
  if(type==='checkup')return 'physical_exam';
  if(type==='inpatient')return 'inpatient';
  if(type==='laboratory')return 'laboratory_exam';
  if(['imaging','functional','pathology'].includes(type))return 'diagnostic_exam';
  if(type==='vaccination')return 'vaccination';
  return 'outpatient';
}

export function previewUploadWorkflow(user: RequestUser, memberId: string, input: unknown) {
  assertMemberManage(user, memberId);
  const ids = reportIdsInput(input);
  const reports = ids.map(id => {
    const row = readReport(user, memberId, id);
    const linked=getDatabase().prepare(`SELECT e.id FROM health_event_resources x JOIN health_events e ON e.id=x.event_id
      WHERE x.resource_type='report' AND x.resource_id=? AND e.member_id=? AND e.deleted_at IS NULL ORDER BY x.created_at,x.id LIMIT 1`).get(id,memberId);
    return { ...row,
      state: linked ? 'archived' : row.state || 'pending',
      eventId: row.eventId || linked?.id || null,
      draft: {eventType: documentGroupType(row.reportType), title: row.title === '待识别报告' ? '' : row.title,
        startedAt: row.reportIssuedAt?.slice(0,10) || '', organizationName: row.organizationName || '', department: row.department || '', reason:''} };
  });
  return {reports};
}

export function listUploadWorkflow(user: RequestUser, memberId: string, cursor?: string) {
  assertMemberManage(user, memberId);
  const rows = getDatabase().prepare(`SELECT r.id FROM reports r LEFT JOIN health_upload_items u ON u.report_id=r.id
    WHERE r.member_id=? AND r.status<>'trashed' AND (u.state IS NULL OR u.state='pending')
    AND NOT (r.report_type='prescription'
      AND COALESCE(json_extract(NULLIF(u.context_json,''),'$.processId'),'')=''
      AND json_extract(NULLIF(u.context_json,''),'$.relatedRecord') IS NULL
      AND COALESCE(json_extract(NULLIF(u.context_json,''),'$.reminderId'),'')='')
    AND (? IS NULL OR r.id<?)
    AND NOT EXISTS(SELECT 1 FROM health_event_resources er JOIN health_events e ON e.id=er.event_id
      WHERE er.resource_type='report' AND er.resource_id=r.id AND e.deleted_at IS NULL)
    ORDER BY r.id DESC LIMIT 101`).all(memberId,cursor||null,cursor||null) as Array<{id:string}>;
  const page = rows.slice(0,100);
  return {...previewUploadWorkflow(user,memberId,page.map(r=>r.id)), nextCursor:rows.length>100?page.at(-1)!.id:null};
}

export function archiveUploadWorkflow(user: RequestUser, input: Record<string, unknown>) {
  const memberId=textInput(input.memberId,'成员',100,true)!;
  assertMemberManage(user,memberId);
  const requestKey=textInput(input.requestKey,'归档请求编号',100,true)!;
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) throw createError({statusCode:400,statusMessage:'归档请求编号无效'});
  if (!Array.isArray(input.groups) || input.groups.length>100) throw createError({statusCode:400,statusMessage:'归档分组无效'});
  const skipIds=reportIdsInput(input.skipReportIds ?? []);
  const groups=input.groups.map(group=>{
    if (!group || typeof group!=='object' || Array.isArray(group)) throw createError({statusCode:400,statusMessage:'归档分组无效'});
    const ids=reportIdsInput(group.reportIds,50);
    if (!ids.length || !group.event) throw createError({statusCode:400,statusMessage:'请确认资料分组'});
    if (group.event && (typeof group.event!=='object'||Array.isArray(group.event))) throw createError({statusCode:400,statusMessage:'新事件信息无效'});
    return {...group,reportIds:ids};
  });
  const allIds=[...groups.flatMap(group=>group.reportIds),...skipIds];
  if (!allIds.length || allIds.length>100 || new Set(allIds).size!==allIds.length) throw createError({statusCode:400,statusMessage:'每份资料只能归入一个分组或跳过'});
  const hash=createHash('sha256').update(JSON.stringify({groups,skipIds})).digest('hex');
  const db=getDatabase();
  let result:{events:Array<{eventId:string;reportIds:string[]}>;skippedReportIds:string[]} | undefined;
  runInTransaction(db,()=>{
    const receipt=db.prepare('SELECT content_hash AS hash,response_json AS response FROM health_upload_archives WHERE user_id=? AND member_id=? AND request_key=?')
      .get(user.id,memberId,requestKey) as {hash:string;response:string}|undefined;
    if(receipt){
      if(receipt.hash!==hash) throw createError({statusCode:409,statusMessage:'重试归档内容发生变化，请重新确认'});
      const previous=JSON.parse(receipt.response) as NonNullable<typeof result>;
      const stale = () => createError({statusCode:409,statusMessage:'归档记录已发生变化，请刷新后查看当前资料'});
      for(const reportId of [...previous.events.flatMap(group=>group.reportIds),...previous.skippedReportIds]) {
        if(!db.prepare("SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed'").get(reportId,memberId))throw stale();
      }
      for(const group of previous.events){
        if(!db.prepare('SELECT 1 FROM health_events WHERE id=? AND member_id=? AND deleted_at IS NULL').get(group.eventId,memberId))throw stale();
        for(const reportId of group.reportIds)if(!db.prepare("SELECT 1 FROM health_event_resources WHERE event_id=? AND resource_type='report' AND resource_id=?").get(group.eventId,reportId))throw stale();
      }
      result=previous; return;
    }
    // The check and all writes share one immediate transaction; another confirmation cannot create duplicate events.
    for(const id of allIds){
      const row=readReport(user,memberId,id);
      if(row.state==='archived'||db.prepare(`SELECT 1 FROM health_event_resources er JOIN health_events e ON e.id=er.event_id
        WHERE er.resource_type='report' AND er.resource_id=? AND e.deleted_at IS NULL`).get(id))
        throw createError({statusCode:409,statusMessage:'部分资料已归档，请刷新后查看'});
    }
    result={events:[],skippedReportIds:skipIds};
    for(const group of groups){
      const eventId=createHealthEvent(user,{...group.event,memberId,reportIds:group.reportIds}).id;
      for(const id of group.reportIds) db.prepare(`INSERT INTO health_upload_items(report_id,state,event_id) VALUES(?,'archived',?)
        ON CONFLICT(report_id) DO UPDATE SET state='archived',event_id=excluded.event_id,updated_at=CURRENT_TIMESTAMP`).run(id,eventId);
      result.events.push({eventId,reportIds:group.reportIds});
    }
    for(const id of skipIds) db.prepare(`INSERT INTO health_upload_items(report_id,state) VALUES(?,'skipped')
      ON CONFLICT(report_id) DO UPDATE SET state='skipped',updated_at=CURRENT_TIMESTAMP`).run(id);
    db.prepare('INSERT INTO health_upload_archives(user_id,member_id,request_key,content_hash,response_json) VALUES(?,?,?,?,?)')
      .run(user.id,memberId,requestKey,hash,JSON.stringify(result));
  });
  return result!;
}
