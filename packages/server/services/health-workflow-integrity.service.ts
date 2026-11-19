import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { healthProcessTables } from '../database/health-process-draft';
import { medicationDraftTables } from '../database/medication-draft';
import { assertMemberAccess } from './member.service';
import { createId } from '../utils/identifier';

/** Runs inside report merge's transaction. The source snapshot remains the original evidence. */
export function mergeReportWorkflow(db: DatabaseSync, sourceId: string, targetId: string) {
  // Explicit record edges follow the surviving report, including deduplication and self-edge removal.
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_record_links'").get()) {
    db.prepare("UPDATE health_record_reminders SET anchor_id=? WHERE anchor_kind IN ('report','medication_document') AND anchor_id=?").run(targetId,sourceId);
    db.prepare("UPDATE health_record_reminders SET completed_id=? WHERE completed_kind IN ('report','medication_document') AND completed_id=?").run(targetId,sourceId);
    const source=db.prepare("SELECT * FROM health_record_process_nodes WHERE kind='report' AND record_id=?").get(sourceId);
    if(source)db.prepare("INSERT INTO health_record_process_nodes(member_id,kind,record_id,process_id,stage_override) VALUES(?,'report',?,?,?) ON CONFLICT DO NOTHING").run(source.member_id,targetId,source.process_id,source.stage_override);
    for(const edge of db.prepare("SELECT * FROM health_record_links WHERE (source_kind='report' AND source_id=?) OR (target_kind='report' AND target_id=?)").all(sourceId,sourceId)) {
      const refs=[{kind:String(edge.source_kind),id:String(edge.source_id)},{kind:String(edge.target_kind),id:String(edge.target_id)}].map(ref=>ref.kind==='report'&&ref.id===sourceId?{kind:'report',id:targetId}:ref).sort((a,b)=>`${a.kind}:${a.id}`<`${b.kind}:${b.id}`?-1:1);
      if(refs[0].kind!==refs[1].kind||refs[0].id!==refs[1].id)db.prepare('INSERT INTO health_record_links(member_id,source_kind,source_id,target_kind,target_id,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(edge.member_id,refs[0].kind,refs[0].id,refs[1].kind,refs[1].id,edge.created_by,edge.created_at);
    }
    db.prepare("DELETE FROM health_record_links WHERE (source_kind='report' AND source_id=?) OR (target_kind='report' AND target_id=?)").run(sourceId,sourceId);
    db.prepare("DELETE FROM health_record_process_nodes WHERE kind='report' AND record_id=?").run(sourceId);
  }
  db.prepare('UPDATE health_vaccinations SET source_report_id=?,source_fact_id=NULL,revision=revision+1 WHERE source_report_id=?').run(targetId,sourceId);
  const links = db.prepare("SELECT * FROM health_event_resources WHERE resource_type='report' AND resource_id=?").all(sourceId);
  for (const link of links) db.prepare(`INSERT INTO health_event_resources
    (id,event_id,resource_type,resource_id,relation_type,sort_order,created_by)
    VALUES(?,?,'report',?,?,?,?) ON CONFLICT(event_id,resource_type,resource_id) DO NOTHING`)
    .run(createId('event_resource'), link.event_id, targetId, link.relation_type, link.sort_order, link.created_by);
  db.prepare("DELETE FROM health_event_resources WHERE resource_type='report' AND resource_id=?").run(sourceId);
  db.prepare('UPDATE reminders SET report_id=? WHERE report_id=?').run(targetId, sourceId);
  db.prepare(`UPDATE medication_courses SET source_report_id=?,source_medication_id=NULL,
    updated_at=CURRENT_TIMESTAMP WHERE source_report_id=?`).run(targetId, sourceId);
  db.prepare(`UPDATE medication_intakes SET source_report_id=?,source_medication_id=NULL,
    updated_at=CURRENT_TIMESTAMP WHERE source_report_id=?`).run(targetId,sourceId);
  // Preserve explicit target context; otherwise carry the source's pending organization forward.
  db.prepare(`INSERT INTO health_upload_items(report_id,context_json,state,event_id)
    SELECT ?,context_json,state,event_id FROM health_upload_items WHERE report_id=?
    ON CONFLICT(report_id) DO NOTHING`).run(targetId, sourceId);
  const event = db.prepare(`SELECT er.event_id FROM health_event_resources er JOIN health_events e ON e.id=er.event_id
    WHERE er.resource_type='report' AND er.resource_id=? AND e.deleted_at IS NULL ORDER BY er.created_at,er.id LIMIT 1`).get(targetId);
  if (event) db.prepare(`INSERT INTO health_upload_items(report_id,state,event_id) VALUES(?,'archived',?)
    ON CONFLICT(report_id) DO UPDATE SET state='archived',event_id=excluded.event_id,context_json='{}',updated_at=CURRENT_TIMESTAMP`)
    .run(targetId, event.event_id);
  db.prepare("DELETE FROM health_upload_items WHERE report_id=?").run(sourceId);
}

const uploadTables = ['health_upload_items', 'health_upload_archives'];
export function validateHealthWorkflowDatabase(db: DatabaseSync): string[] {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const errors: string[] = [];
  for (const group of [healthProcessTables, medicationDraftTables, uploadTables, ['health_workflow_requests'], ['health_record_processes','health_record_process_nodes','health_record_links','health_record_reminders']]) {
    if (!group.some(table => tables.has(table))) continue;
    for (const table of group) if (!tables.has(table)) errors.push(`备份数据库缺少健康历程关联表：${table}`);
    if (!tables.has('health_events') || !tables.has('health_episodes')) errors.push('健康历程关联表缺少事件或过程主体');
  }
  if (errors.length) return errors;
  if (tables.has('health_record_links') && tables.has('health_record_process_nodes')) {
    const owner = (kind:string,id:string) => {
      if(kind==='symptom')return db.prepare('SELECT p.member_id FROM health_process_symptoms s JOIN health_episodes p ON p.id=s.episode_id WHERE s.id=?').get(id)?.member_id;
      const table=kind==='report'||kind==='medication_document'?'reports':kind==='medication'?'medication_courses':kind==='intake'?'medication_intakes':kind==='vaccination'?'health_vaccinations':null;
      return table?db.prepare(`SELECT member_id FROM ${table} WHERE id=?`).get(id)?.member_id:null;
    };
    for(const edge of db.prepare('SELECT * FROM health_record_links').all())if(owner(String(edge.source_kind),String(edge.source_id))!==edge.member_id||owner(String(edge.target_kind),String(edge.target_id))!==edge.member_id){errors.push('记录关联存在无效记录或跨成员联系');break;}
    for(const node of db.prepare('SELECT n.*,p.member_id AS process_member_id FROM health_record_process_nodes n LEFT JOIN health_record_processes p ON p.id=n.process_id').all())if(owner(String(node.kind),String(node.record_id))!==node.member_id||node.process_id&&node.process_member_id!==node.member_id){errors.push('健康历程成员归属不一致');break;}
    for(const plan of db.prepare('SELECT p.*,r.member_id AS reminder_member_id FROM health_record_reminders p LEFT JOIN reminders r ON r.id=p.reminder_id').all())if(plan.member_id!==plan.reminder_member_id||owner(String(plan.anchor_kind),String(plan.anchor_id))!==plan.member_id||plan.completed_id&&owner(String(plan.completed_kind),String(plan.completed_id))!==plan.member_id){errors.push('健康历程提醒存在无效来源或跨成员联系');break;}
  }

  if(tables.has('health_record_process_trash')) {
    if(!tables.has('health_record_processes'))errors.push('历程回收站缺少历程主体表');
    else for(const row of db.prepare('SELECT t.*,p.member_id AS owner FROM health_record_process_trash t LEFT JOIN health_record_processes p ON p.id=t.process_id').all()) {
      let valid=row.member_id===row.owner;
      if(row.deleted_at)try{const snapshot=JSON.parse(String(row.snapshot_json));valid=valid&&Array.isArray(snapshot.nodes)&&Array.isArray(snapshot.edges);}catch{valid=false;}
      if(!valid){errors.push('健康历程回收站快照或成员归属无效');break;}
    }
  }

  if (healthProcessTables.every(table => tables.has(table))) {
    const badTargets = db.prepare(`SELECT 1 FROM health_process_symptom_revisions r
      LEFT JOIN health_process_symptoms s ON r.target_type='symptom' AND s.id=r.target_id
      LEFT JOIN health_process_symptom_updates u ON r.target_type='update' AND u.id=r.target_id
      LEFT JOIN health_process_symptoms us ON us.id=u.symptom_id
      WHERE COALESCE(s.episode_id,us.episode_id,'')<>r.episode_id LIMIT 1`).get();
    const revisions = db.prepare('SELECT target_type,target_id,episode_id,snapshot_json FROM health_process_symptom_revisions').all();
    const badSnapshots = revisions.some(row => {
      try {
        const snapshot = JSON.parse(String(row.snapshot_json));
        if (!snapshot || snapshot.id !== row.target_id) return true;
        if (row.target_type === 'symptom') return snapshot.episode_id !== row.episode_id;
        const symptom = db.prepare('SELECT episode_id FROM health_process_symptoms WHERE id=?').get(snapshot.symptom_id ?? null);
        return symptom?.episode_id !== row.episode_id;
      } catch { return true; }
    });
    if (badTargets || badSnapshots) errors.push('数据库存在不一致的症状修订记录关联');
  }
  if (medicationDraftTables.every(table => tables.has(table))) {
    const badIntakes = db.prepare(`SELECT 1 FROM medication_intakes i JOIN medication_courses c ON c.id=i.course_id
      WHERE i.member_id<>c.member_id LIMIT 1`).get();
    const badSources = db.prepare(`SELECT 1 FROM medication_courses c JOIN reports r ON r.id=c.source_report_id
      WHERE c.member_id<>r.member_id LIMIT 1`).get();
    const intakeColumns=new Set(db.prepare('PRAGMA table_info(medication_intakes)').all().map(row=>String(row.name)));
    const badIntakeSources=intakeColumns.has('source_report_id') && db.prepare(`SELECT 1 FROM medication_intakes i JOIN reports r ON r.id=i.source_report_id WHERE i.member_id<>r.member_id LIMIT 1`).get();
    if (badIntakes || badSources || badIntakeSources) errors.push('数据库存在跨成员的用药关联');
  }
  if (tables.has('health_upload_items')) {
    const bad = db.prepare(`SELECT 1 FROM health_upload_items u JOIN reports r ON r.id=u.report_id
      JOIN health_events e ON e.id=u.event_id WHERE r.member_id<>e.member_id LIMIT 1`).get();
    if (bad) errors.push('数据库存在跨成员的上传归档关联');
    const contexts = db.prepare(`SELECT u.context_json,r.member_id FROM health_upload_items u
      JOIN reports r ON r.id=u.report_id`).all();
    const badContext = contexts.some(row => {
      try {
        const context = JSON.parse(String(row.context_json));
        if (!context || typeof context !== 'object' || Array.isArray(context)) return true;
        if(context.relatedRecord!=null){
          const ref=context.relatedRecord;
          if(!ref||typeof ref!=='object'||typeof ref.id!=='string')return true;
          const table=ref.kind==='report'||ref.kind==='medication_document'?'reports':ref.kind==='medication'?'medication_courses':ref.kind==='intake'?'medication_intakes':ref.kind==='vaccination'?'health_vaccinations':null;
          const member=ref.kind==='symptom'?db.prepare('SELECT p.member_id FROM health_process_symptoms s JOIN health_episodes p ON p.id=s.episode_id WHERE s.id=?').get(ref.id)?.member_id:table?db.prepare(`SELECT member_id FROM ${table} WHERE id=?`).get(ref.id)?.member_id:null;
          if(member!==row.member_id)return true;
        }
        return Object.entries({processId:'health_record_processes',reminderId:'reminders'})
          .some(([key,table]) => context[key] != null && (typeof context[key] !== 'string'
            || !db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND member_id=?`).get(context[key],row.member_id)));
      } catch { return true; }
    });
    if (badContext) errors.push('数据库存在无效或跨成员的上传来源关联');
  }
  if(tables.has('health_vaccinations')){
    const invalidVaccine=db.prepare(`SELECT 1 FROM health_vaccinations v LEFT JOIN reports r ON r.id=v.source_report_id LEFT JOIN reminders n ON n.id=v.reminder_id LEFT JOIN reminders c ON c.id=v.completed_reminder_id
      WHERE (r.id IS NOT NULL AND r.member_id<>v.member_id) OR (n.id IS NOT NULL AND n.member_id<>v.member_id) OR (c.id IS NOT NULL AND c.member_id<>v.member_id) LIMIT 1`).get();
    if(invalidVaccine)errors.push('数据库存在跨成员的接种关联');
  }
  return errors;
}

export function exportMemberHealthWorkflow(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const db = getDatabase();
  return {
    recordProcesses: db.prepare('SELECT * FROM health_record_processes WHERE member_id=?').all(memberId),
    processTrash: db.prepare('SELECT * FROM health_record_process_trash WHERE member_id=?').all(memberId),
    processMetadata:db.prepare('SELECT m.* FROM health_record_process_metadata m JOIN health_record_processes p ON p.id=m.process_id WHERE p.member_id=?').all(memberId),
    processNodes: db.prepare('SELECT * FROM health_record_process_nodes WHERE member_id=?').all(memberId),
    recordReminders:db.prepare('SELECT * FROM health_record_reminders WHERE member_id=?').all(memberId),
    recordLinks: db.prepare('SELECT * FROM health_record_links WHERE member_id=?').all(memberId),
    vaccinations: db.prepare('SELECT * FROM health_vaccinations WHERE member_id=?').all(memberId),
    events: db.prepare('SELECT * FROM health_events WHERE member_id=?').all(memberId),
    resources: db.prepare('SELECT er.* FROM health_event_resources er JOIN health_events e ON e.id=er.event_id WHERE e.member_id=?').all(memberId),
    episodes: db.prepare('SELECT * FROM health_episodes WHERE member_id=?').all(memberId),
    symptoms: db.prepare('SELECT s.* FROM health_process_symptoms s JOIN health_episodes ep ON ep.id=s.episode_id WHERE ep.member_id=?').all(memberId),
    symptomUpdates: db.prepare(`SELECT u.* FROM health_process_symptom_updates u JOIN health_process_symptoms s ON s.id=u.symptom_id
      JOIN health_episodes ep ON ep.id=s.episode_id WHERE ep.member_id=?`).all(memberId),
    symptomRevisions: db.prepare('SELECT sr.* FROM health_process_symptom_revisions sr JOIN health_episodes ep ON ep.id=sr.episode_id WHERE ep.member_id=?').all(memberId),
    medicationCourses: db.prepare('SELECT * FROM medication_courses WHERE member_id=?').all(memberId),
    medicationChanges: db.prepare('SELECT h.* FROM medication_course_changes h JOIN medication_courses c ON c.id=h.course_id WHERE c.member_id=?').all(memberId),
    medicationIntakes: db.prepare('SELECT * FROM medication_intakes WHERE member_id=?').all(memberId),
    // Organization context is useful to the member; retry receipts, account IDs and request keys are not health records.
    uploadItems: db.prepare(`SELECT u.report_id,u.state,u.event_id,u.context_json FROM health_upload_items u
      JOIN reports r ON r.id=u.report_id WHERE r.member_id=?`).all(memberId).map(row => {
        const source = JSON.parse(String(row.context_json));
        return {report_id:row.report_id,state:row.state,event_id:row.event_id,
          context:Object.fromEntries(['processId','reminderId','relatedRecord']
            .filter(key => source?.[key]!==undefined).map(key => [key,source[key]]))};
      }),
    reminders: db.prepare('SELECT * FROM reminders WHERE member_id=?').all(memberId)
  };
}
