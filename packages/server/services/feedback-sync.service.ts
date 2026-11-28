import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createError } from 'h3';
import { getDatabase, getUnreleasedSchemaMaintenance } from '../database/client';
import { resolveFeedbackAppsIdentity } from './feedback-installation.service';
import { sendFeedbackRequest } from './feedback-remote.service';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { storageMigrationPaused, trackStorageRequest, finishStorageRequest } from '../utils/storage-migration-state';

const labels: Record<string, string> = {
  received: '已收到', needs_info: '待补充', confirmed: '已确认', in_progress: '处理中',
  fixed_pending_release: '已修复，待发布', released_pending_verification: '已发布，待验证',
  resolved: '已解决', closed: '已关闭'
};
export type FeedbackState = { number: string; status: string; version: number };
export type FeedbackList = { items: (FeedbackState & Record<string, unknown>)[]; total: number };
const identityHash = (id: string) => createHash('sha256').update(id).digest('hex');
const running = new WeakMap<DatabaseSync, Promise<FeedbackList>>();

function validState(value: unknown): value is FeedbackState {
  if (!value || typeof value !== 'object') return false;
  const item = value as FeedbackState;
  return /^(?:[BSO]\d{4,20}|FB-\d{4}-\d{6,20})$/.test(item.number)
    && Object.hasOwn(labels, item.status) && Number.isSafeInteger(item.version) && item.version > 0;
}
function parseList(value: unknown): FeedbackList {
  const list = value as FeedbackList;
  if (!list || !Array.isArray(list.items) || !Number.isSafeInteger(list.total) || list.total < list.items.length
    || list.items.some(item => !validState(item))) throw new Error('反馈列表响应无效');
  return list;
}

// Persist the comparison and notification together. Higher versions suppress late responses;
// a changed version alone (for example a reply) never creates a status notification.
export function recordFeedbackStates(db: DatabaseSync, clientId: string, items: FeedbackState[], notify = true) {
  if (items.some(item => !validState(item))) throw new Error('反馈状态响应无效');
  const hash = identityHash(clientId);
  db.exec('SAVEPOINT feedback_snapshot');
  try {
    for (const item of items) {
      const previous = db.prepare('SELECT status,remote_version FROM feedback_sync_state WHERE client_hash=? AND number=?')
        .get(hash, item.number) as { status: string; remote_version: number } | undefined;
      if (previous && item.version <= previous.remote_version) continue;
      if (notify && previous && previous.status !== item.status) {
        db.prepare('INSERT OR IGNORE INTO feedback_notifications(id,client_hash,number,remote_version,message) VALUES (?,?,?,?,?)')
          .run(createId('feedback_notice'), hash, item.number, item.version,
            `反馈 ${item.number} 已从“${labels[previous.status] || '原状态'}”更新为“${labels[item.status]}”。`);
      }
      db.prepare(`INSERT INTO feedback_sync_state(client_hash,number,status,remote_version) VALUES (?,?,?,?)
        ON CONFLICT(client_hash,number) DO UPDATE SET status=excluded.status,remote_version=excluded.remote_version`)
        .run(hash, item.number, item.status, item.version);
    }
    db.exec('RELEASE feedback_snapshot');
  } catch (error) {
    db.exec('ROLLBACK TO feedback_snapshot; RELEASE feedback_snapshot');
    throw error;
  }
}

// One complete snapshot per concurrent sync. No partial baseline is committed on network failure.
export function syncFeedbackUpdates(db = getDatabase(), send: typeof sendFeedbackRequest = sendFeedbackRequest): Promise<FeedbackList> {
  const pending = running.get(db);
  if (pending) return pending;
  const request = (async () => {
    if (storageMigrationPaused() || getUnreleasedSchemaMaintenance()) throw new Error('应用正在维护');
    const identity = resolveFeedbackAppsIdentity(db);
    const marker = {};
    trackStorageRequest(marker);
    try {
      const signal = AbortSignal.timeout(30000);
      const collected = new Map<string, FeedbackList['items'][number]>();
      let total = 0;
      for (let page = 1; page <= 10000; page++) {
        const result = parseList(await send(`/tickets?page=${page}&pageSize=50`, { signal },
          { fetch: globalThis.fetch, resolveIdentity: () => identity }));
        total = result.total;
        for (const item of result.items) {
          const existing = collected.get(item.number);
          if (!existing || item.version > existing.version) collected.set(item.number, item);
        }
        if (collected.size >= total) break;
        if (!result.items.length || page === 10000 || signal.aborted) throw new Error('反馈列表同步未完成');
      }
      if (storageMigrationPaused() || resolveFeedbackAppsIdentity(db).localKey !== identity.localKey) throw new Error('反馈安装身份已变化');
      const items = [...collected.values()];
      recordFeedbackStates(db, identity.localKey, items);
      return { items, total };
    } finally { finishStorageRequest(marker); }
  })();
  running.set(db, request);
  void request.finally(() => { if (running.get(db) === request) running.delete(db); }).catch(() => {});
  return request;
}

export function listFeedbackNotifications(user: RequestUser, db = getDatabase()) {
  if (!user.authenticated || !isAdministrator(user)) return [];
  const identity = resolveFeedbackAppsIdentity(db);
  return db.prepare(`SELECT n.id,NULL AS memberId,NULL AS reportId,'feedback_updated' AS type,
    '反馈进度更新' AS title,n.message,'info' AS severity,COALESCE(r.status,'unread') AS status,
    n.created_at AS createdAt,r.read_at AS readAt,NULL AS reportTitle,n.number AS feedbackNumber
    FROM feedback_notifications n LEFT JOIN feedback_notification_reads r ON r.notification_id=n.id AND r.user_id=?
    WHERE n.client_hash=? AND COALESCE(r.status,'unread')<>'archived'
    ORDER BY COALESCE(r.status,'unread')='unread' DESC,n.created_at DESC,n.id DESC LIMIT 100`)
    .all(user.id, identityHash(identity.localKey));
}
export function updateFeedbackNotification(user: RequestUser, id: string, status: string, db = getDatabase()) {
  if (!user.authenticated || !isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: '仅管理员可管理反馈提醒' });
  if (!['unread','read','archived'].includes(status)) throw createError({ statusCode: 400, statusMessage: '通知状态无效' });
  const identity = resolveFeedbackAppsIdentity(db);
  if (!db.prepare('SELECT id FROM feedback_notifications WHERE id=? AND client_hash=?').get(id, identityHash(identity.localKey)))
    throw createError({ statusCode: 404, statusMessage: '通知不存在' });
  db.prepare(`INSERT INTO feedback_notification_reads(notification_id,user_id,status,read_at)
    VALUES (?,?,?,CASE WHEN ?='unread' THEN NULL ELSE CURRENT_TIMESTAMP END)
    ON CONFLICT(notification_id,user_id) DO UPDATE SET status=excluded.status,
    read_at=CASE WHEN excluded.status='unread' THEN NULL ELSE COALESCE(feedback_notification_reads.read_at,excluded.read_at) END`)
    .run(id, user.id, status, status);
  return { id, status };
}
