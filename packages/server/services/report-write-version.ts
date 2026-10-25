import { createError } from 'h3';
import { getDatabase } from '../database/client';

/** Run inside the write transaction. Older clients may omit the version. */
export function assertReportWriteVersion(reportId:string,expected:unknown) {
  if(expected===undefined)return;
  const row=getDatabase().prepare("SELECT source_version AS version FROM reports WHERE id=? AND status<>'trashed' AND deleted_at IS NULL").get(reportId);
  if(!row||!Number.isSafeInteger(expected)||row.version!==expected)
    throw createError({statusCode:409,statusMessage:'报告内容已变化，请刷新后重新核对，当前修改尚未保存'});
}
export function bumpReportWriteVersion(reportId:string) {
  getDatabase().prepare('UPDATE reports SET source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(reportId);
}
