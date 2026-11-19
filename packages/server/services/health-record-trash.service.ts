import { retireUnusedVaccinationOriginal } from './records.service';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { HealthTrashEntry, HealthTrashPage } from '../../shared/health-record-trash';
import { assertMemberAccess, assertMemberManage } from './member.service';
import { createId } from '../utils/identifier';

function fail(message: string): never { throw createError({ statusCode: 409, statusMessage: message }); }
function vaccination(id: string) {
  const row = getDatabase().prepare('SELECT * FROM health_vaccinations WHERE id=?').get(id);
  if (!row) throw createError({ statusCode: 404, statusMessage: '接种信息不存在' });
  return row;
}
function audit(actor: string | null, id: string, action: string, details: Record<string, unknown> = {}) {
  getDatabase().prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json)
    VALUES(?,?,?,'vaccination',?,?)`).run(createId('audit'), actor, action, id, JSON.stringify(details));
}
function revision(row: ReturnType<typeof vaccination>, input: Record<string, unknown>) {
  if (input.revision !== row.revision) fail('接种信息已变化，请刷新后重试');
}
export function listHealthTrash(user: RequestUser, memberId: string, input: { cursor?: string; limit?: number } = {}): HealthTrashPage {
  assertMemberAccess(user, memberId);
  const limit = input.limit ?? 30;
  if (!Number.isFinite(limit)) throw createError({ statusCode: 400, statusMessage: '分页数量无效' });
  const size = Math.max(1, Math.min(50, Math.round(limit)));
  let cursor: { memberId: string; at: string; key: string } | undefined;
  if (input.cursor) {
    try {
      if (input.cursor.length > 1000) throw Error();
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (!cursor || cursor.memberId !== memberId || typeof cursor.at !== 'string' || typeof cursor.key !== 'string') throw Error();
    } catch { throw createError({ statusCode: 400, statusMessage: '回收站分页信息无效，请刷新重试' }); }
  }
  const sql = `WITH entries AS (
    SELECT id,'report' AS kind,member_id AS memberId,title,
      COALESCE(report_issued_at,reviewed_at,received_at,examined_at,sampled_at,ordered_at) AS date,NULL AS doseNumber,hospital_name_raw AS institution,
      strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at) AS deletedAt,
      strftime('%Y-%m-%dT%H:%M:%fZ',purge_after) AS purgeAfter,NULL AS revision,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),strftime('%Y-%m-%dT%H:%M:%fZ',created_at),'') AS sortAt,'report:'||id AS sortKey
    FROM reports WHERE member_id=? AND status='trashed'
    UNION ALL
    SELECT v.id,'vaccination',v.member_id,v.vaccine_name,v.administered_at,v.dose_number,v.organization_name,
      strftime('%Y-%m-%dT%H:%M:%fZ',v.deleted_at),
      strftime('%Y-%m-%dT%H:%M:%fZ',v.purge_after),v.revision,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',v.deleted_at),' '),'vaccination:'||v.id
    FROM health_vaccinations v WHERE v.member_id=? AND v.deleted_at IS NOT NULL
    UNION ALL
    SELECT s.id,'symptom',e.member_id,s.name,s.started_at,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',s.deleted_at),strftime('%Y-%m-%dT%H:%M:%fZ',s.purge_after),s.version,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',s.deleted_at),''),'symptom:'||s.id
    FROM health_process_symptoms s JOIN health_episodes e ON e.id=s.episode_id WHERE e.member_id=? AND s.deleted_at IS NOT NULL
    UNION ALL
    SELECT id,'medication',member_id,medication_name,started_at,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),strftime('%Y-%m-%dT%H:%M:%fZ',purge_after),revision,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),''),'medication:'||id
    FROM medication_courses WHERE member_id=? AND deleted_at IS NOT NULL
    UNION ALL
    SELECT id,'intake',member_id,medication_name,taken_at,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),strftime('%Y-%m-%dT%H:%M:%fZ',purge_after),revision,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),''),'intake:'||id
    FROM medication_intakes WHERE member_id=? AND deleted_at IS NOT NULL
    UNION ALL
    SELECT process_id,'process',member_id,title,started_at,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),strftime('%Y-%m-%dT%H:%M:%fZ',purge_after),revision,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at),''),'process:'||process_id
    FROM health_record_process_trash WHERE member_id=? AND deleted_at IS NOT NULL
  ) SELECT * FROM entries ${cursor ? 'WHERE sortAt<? OR (sortAt=? AND sortKey<?)' : ''}
    ORDER BY sortAt DESC,sortKey DESC LIMIT ?`;
  const params: Array<string | number> = [memberId, memberId, memberId, memberId, memberId, memberId];
  if (cursor) params.push(cursor.at, cursor.at, cursor.key);
  params.push(size + 1);
  const rows = getDatabase().prepare(sql).all(...params) as Array<HealthTrashEntry & { sortAt: string; sortKey: string }>;
  const hasMore = rows.length > size;
  const visible = rows.slice(0, size); const last = visible.at(-1);
  return { items: visible.map(({ sortAt, sortKey, ...item }) => item), hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ memberId, at: last.sortAt, key: last.sortKey })).toString('base64url') : null };
}

export function trashVaccination(user: RequestUser, id: string, input: Record<string, unknown>) {
  return runInTransaction(getDatabase(), () => {
    const row = vaccination(id); assertMemberManage(user, String(row.member_id)); revision(row, input);
    if (row.deleted_at) return { id, status: 'trashed' as const };
    const db = getDatabase();
    if (row.reminder_id && db.prepare('SELECT 1 FROM health_vaccinations WHERE completed_reminder_id=? AND deleted_at IS NULL').get(row.reminder_id))
      fail('这次接种已关联后一剂，请先将后一剂接种记录移入回收站');
    const reminder = row.reminder_id ? db.prepare('SELECT status,confirmed_at FROM reminders WHERE id=? AND member_id=?').get(row.reminder_id, row.member_id) : null;
    const deletedAt = new Date().toISOString();
    const purgeAfter = new Date(Date.parse(deletedAt) + 30 * 86400000).toISOString();
    db.prepare('UPDATE health_vaccinations SET deleted_at=?,purge_after=?,trash_state_json=?,updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?').run(deletedAt,purgeAfter,JSON.stringify({reminderStatus:reminder?.status??null,reminderConfirmedAt:reminder?.confirmed_at??null}),id);
    if (row.reminder_id) db.prepare("UPDATE reminders SET status='dismissed' WHERE id=? AND member_id=? AND status='pending'").run(row.reminder_id, row.member_id);
    if (row.completed_reminder_id) db.prepare("UPDATE reminders SET status='pending' WHERE id=? AND member_id=? AND status='completed'").run(row.completed_reminder_id, row.member_id);
    audit(user.id, id, 'vaccination.trash', { deletedAt, purgeAfter, revision: Number(row.revision) + 1, reminderStatus: reminder?.status ?? null });
    return { id, status: 'trashed' as const, purgeAfterDays: 30 };
  });
}

export function restoreVaccination(user: RequestUser, id: string, input: Record<string, unknown>) {
  return runInTransaction(getDatabase(), () => {
    const row = vaccination(id); assertMemberManage(user, String(row.member_id)); revision(row, input);
    if (!row.deleted_at) return { id, status: 'active' as const };
    const db = getDatabase();
    if (row.source_report_id && row.source_fact_id && db.prepare(`SELECT 1 FROM health_vaccinations WHERE member_id=? AND source_report_id=? AND source_fact_id=? AND deleted_at IS NULL AND id<>?`).get(row.member_id,row.source_report_id,row.source_fact_id,id))
      fail('这份凭证已重新登记接种，请先核对已有记录，避免重复恢复');
    if (row.completed_reminder_id) {
      const parent = db.prepare('SELECT administered_at,deleted_at FROM health_vaccinations WHERE reminder_id=? AND member_id=?').get(row.completed_reminder_id,row.member_id);
      if (parent?.deleted_at) fail('请先恢复前一剂接种记录，再恢复本次接种');
      if (parent && String(parent.administered_at).slice(0,10)>String(row.administered_at).slice(0,10)) fail('前一剂日期已变化，请先核对前一剂接种日期');
      if (db.prepare('SELECT 1 FROM health_vaccinations WHERE completed_reminder_id=? AND deleted_at IS NULL AND id<>?').get(row.completed_reminder_id,id))
        fail('该提醒已登记了其他接种，请先核对已有记录，避免重复恢复');
    }
    const state = row.trash_state_json ? JSON.parse(String(row.trash_state_json)) as { reminderStatus?: string; reminderConfirmedAt?: string | null } : null;
    db.prepare(`UPDATE health_vaccinations SET deleted_at=NULL,purge_after=NULL,trash_state_json=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP,
      next_due_at=COALESCE((SELECT due_at FROM reminders WHERE id=health_vaccinations.reminder_id AND member_id=health_vaccinations.member_id),next_due_at),
      source_fact_id=CASE WHEN source_report_id IS NULL THEN NULL ELSE source_fact_id END WHERE id=?`).run(id);
    if (row.reminder_id && state?.reminderStatus === 'pending')
      db.prepare("UPDATE reminders SET status='pending' WHERE id=? AND member_id=? AND status='dismissed' AND confirmed_at IS ?").run(row.reminder_id,row.member_id,state.reminderConfirmedAt??null);
    if (row.completed_reminder_id)
      db.prepare("UPDATE reminders SET status='completed' WHERE id=? AND member_id=? AND status IN ('pending','dismissed')").run(row.completed_reminder_id,row.member_id);
    audit(user.id,id,'vaccination.restore');
    // Missing restoration metadata cannot justify changing an existing reminder status.
    return { id, status: 'active' as const, reminderNeedsReview: Boolean(!state && row.reminder_id) };
  });
}
function purgeVaccination(id: string, actor: string | null) {
  const db = getDatabase();
  return runInTransaction(db, () => {
    const row = vaccination(id);
    if (!row.deleted_at) fail('只有回收站中的接种记录可以永久删除');
    if (row.reminder_id && db.prepare('SELECT 1 FROM health_vaccinations WHERE completed_reminder_id=? AND deleted_at IS NULL').get(row.reminder_id))
      fail('存在关联的后一剂接种，请先核对相关记录');
    // A permanently removed parent can no longer provide reminder context to a recoverable child.
    if (row.reminder_id) db.prepare('UPDATE health_vaccinations SET completed_reminder_id=NULL,revision=revision+1 WHERE completed_reminder_id=?').run(row.reminder_id);
    db.prepare('DELETE FROM health_vaccinations WHERE id=?').run(id);
    if (row.source_report_id) retireUnusedVaccinationOriginal(String(row.source_report_id),String(row.member_id),actor);
    audit(actor,id,'vaccination.purge');
    return { id, deleted: true, pendingFileCount: 0 };
  });
}
export function permanentlyDeleteVaccination(user: RequestUser, id: string, input: Record<string, unknown>) {
  return runInTransaction(getDatabase(), () => {
    const row = vaccination(id); assertMemberManage(user,String(row.member_id)); revision(row,input);
    return purgeVaccination(id,user.id);
  });
}
export function purgeExpiredVaccinations(limit = 50) {
  const db = getDatabase();
  // Old retractions have no retention metadata and stay recoverable until the user explicitly acts.
  const rows = db.prepare(`SELECT v.id FROM health_vaccinations v WHERE v.deleted_at IS NOT NULL
    AND julianday(v.purge_after)<=julianday('now')
    ORDER BY v.deleted_at,v.id LIMIT ?`).all(Math.max(1,Math.min(200,Math.round(limit))));
  let deleted = 0; let failed = 0;
  for (const row of rows) { try { purgeVaccination(String(row.id),null); deleted++; } catch { failed++; } }
  return { checked: rows.length, deleted, failed };
}

export const standaloneTrashKinds = ['symptom','medication','intake'] as const;
type StandaloneKind = typeof standaloneTrashKinds[number];
const standaloneTables: Record<StandaloneKind,string> = {symptom:'health_process_symptoms',medication:'medication_courses',intake:'medication_intakes'};
function standalone(kind:StandaloneKind,id:string) {
  const db=getDatabase();const table=standaloneTables[kind];
  if(!table)throw createError({statusCode:400,statusMessage:'记录类型无效'});
  const row=kind==='symptom'?db.prepare(`SELECT s.*,e.member_id,e.deleted_at AS parent_deleted_at FROM health_process_symptoms s JOIN health_episodes e ON e.id=s.episode_id WHERE s.id=?`).get(id):db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if(!row)throw createError({statusCode:404,statusMessage:'记录不存在或已永久删除'});
  return row;
}
function purgeStandalone(kind:StandaloneKind,id:string,actor:string|null) {
  const db=getDatabase();return runInTransaction(db,()=>{
    const row=standalone(kind,id);if(!row.deleted_at)fail('只有回收站中的记录可以永久删除');
    if(kind==='symptom'){
      db.prepare(`DELETE FROM health_process_symptom_revisions WHERE (target_type='symptom' AND target_id=?) OR (target_type='update' AND target_id IN (SELECT id FROM health_process_symptom_updates WHERE symptom_id=?))`).run(id,id);
    }
    if(kind==='medication')db.prepare('DELETE FROM medication_intakes WHERE course_id=? AND deleted_at IS NULL').run(id);
    db.prepare(`DELETE FROM ${standaloneTables[kind]} WHERE id=?`).run(id);
    db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,?,?,'{}')`).run(createId('audit'),actor,`${kind}.purge`,kind,id);
    return {id,deleted:true,pendingFileCount:0};
  });
}
export function mutateStandaloneTrash(user:RequestUser,kind:StandaloneKind,id:string,input:Record<string,unknown>,operation:'trash'|'restore'|'purge') {
  return runInTransaction(getDatabase(),()=>{
    const row=standalone(kind,id);assertMemberManage(user,String(row.member_id));
    const versionKey=kind==='symptom'?'version':'revision';if(input.revision!==row[versionKey])fail('记录已变化，请刷新后重试');
    if(operation==='purge')return purgeStandalone(kind,id,user.id);
    const db=getDatabase();const restoring=operation==='restore';
    if(Boolean(row.deleted_at)!==restoring)fail(restoring?'这条记录已恢复，请刷新列表':'这条记录已移入回收站，请刷新列表');
    if(restoring && kind==='symptom' && row.parent_deleted_at)fail('所属健康历程已移除，请先核对所属过程');
    if(restoring && kind==='intake' && row.course_id && db.prepare('SELECT 1 FROM medication_courses WHERE id=? AND deleted_at IS NOT NULL').get(row.course_id))fail('请先恢复所属用药记录，再恢复这次服药记录');
    if(!restoring && kind==='intake' && row.course_id && db.prepare('SELECT 1 FROM medication_courses WHERE id=? AND deleted_at IS NOT NULL').get(row.course_id))fail('所属用药记录已移入回收站，请先恢复用药记录');
    if(kind==='symptom' && !restoring){
      const {member_id,parent_deleted_at,...snapshot}=row;
      db.prepare(`INSERT INTO health_process_symptom_revisions(id,episode_id,target_type,target_id,operation,snapshot_json,created_by) VALUES(?,?,'symptom',?,'retract',?,?)`).run(createId('symptom_revision'),row.episode_id,id,JSON.stringify(snapshot),user.id);
    }
    const deletedAt=restoring?null:new Date().toISOString();const purgeAfter=deletedAt?new Date(Date.parse(deletedAt)+30*86400000).toISOString():null;
    db.prepare(`UPDATE ${standaloneTables[kind]} SET deleted_at=?,purge_after=?,${versionKey}=${versionKey}+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(deletedAt,purgeAfter,id);
    db.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,detail_json) VALUES(?,?,?,?,?,'{}')`).run(createId('audit'),user.id,`${kind}.${restoring?'restore':'trash'}`,kind,id);
    return {id,status:restoring?'active':'trashed'};
  });
}
export function purgeExpiredStandaloneRecords(limit=50) {
  let checked=0,deleted=0,failed=0;const db=getDatabase();
  for(const kind of standaloneTrashKinds){
    const rows=db.prepare(`SELECT id FROM ${standaloneTables[kind]} WHERE deleted_at IS NOT NULL AND julianday(purge_after)<=julianday('now') ORDER BY purge_after,id LIMIT ?`).all(Math.max(1,Math.min(200,Math.round(limit))));
    for(const row of rows){checked++;try{purgeStandalone(kind,String(row.id),null);deleted++;}catch{failed++;}}
  }
  return {checked,deleted,failed};
}
