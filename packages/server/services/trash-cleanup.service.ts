import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberManage } from './member.service';
import { cleanupSchedule, getMaintenanceState } from '../utils/maintenance-state';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';

const reasons:Record<string,string>={
 STORAGE_UNAVAILABLE:'存储当前不可用，请管理员检查存储挂载、可用空间及目录访问权限。',
 STORAGE_MIGRATION:'存储迁移或恢复期间暂缓清理，完成后等待后台检查。',
 SCHEDULE_UNKNOWN:'后台清理计划尚未就绪，暂时无法确定检查时间。',
 SCHEDULE_OVERDUE:'清理已延期，计划检查尚未正常执行，暂时无法确定下一次检查时间。',
 MAINTENANCE_RUNNING:'后台维护正在运行，暂时无法确定本成员文件的下一次检查时间。',
 MAINTENANCE_FAILED:'清理已延期，最近一次维护未正常完成文件清理阶段。',
 FILE_RETRY:'部分文件清理失败，等待后台重试；若持续失败，请管理员检查存储目录权限及挂载状态。'
};
export function getTrashCleanupSummary(user:RequestUser,memberId:string) {
 assertMemberManage(user,memberId);
 const now=Date.now();
 const row=getDatabase().prepare(`SELECT COUNT(*) AS pending,
 SUM(CASE WHEN q.last_error IS NOT NULL THEN 1 ELSE 0 END) AS retrying,
 MIN(strftime('%s',q.not_before)) AS earliest,
 SUM(CASE WHEN strftime('%s',q.not_before) IS NULL THEN 1 ELSE 0 END) AS invalid
 FROM file_gc_members m JOIN file_gc_queue q ON q.id=m.gc_id
 WHERE m.member_id=? AND q.completed_at IS NULL`).get(memberId) as {pending:number;retrying:number|null;earliest:string|null;invalid:number|null};
 const base={memberId,serverTime:new Date(now).toISOString(),pendingFileCount:row.pending,retryingFileCount:row.retrying||0};
 if(!row.pending) return {...base,nextCleanupCheckAt:null,status:'none' as const,reasonCode:null,reasonMessage:null};
 const pause=getAppConfig().storageError?'STORAGE_UNAVAILABLE':storageMigrationPaused()?'STORAGE_MIGRATION':null;
 const plan=cleanupSchedule(getMaintenanceState(),row.invalid||row.earliest===null?null:Number(row.earliest)*1000,now,pause);
 const retry=plan.status==='waiting' && Boolean(row.retrying);
 const reasonCode=retry?'FILE_RETRY':plan.reason;
 return {...base,nextCleanupCheckAt:plan.at,status:retry?'retrying' as const:plan.status,reasonCode,reasonMessage:reasonCode?reasons[reasonCode]:null};
}
