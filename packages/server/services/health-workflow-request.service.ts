import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { assertMemberManage } from './member.service';

/** A lost response must not duplicate a confirmed record. Internal calls may reuse an enclosing transaction/receipt. */
export function runHealthWorkflowRequest<T>(user: RequestUser, memberId: string, scope: string,
  input: Record<string, unknown>, create: () => T, readSaved?: (saved: T) => T): T {
  assertMemberManage(user, memberId);
  if (input.requestKey === undefined) return create();
  const { requestKey, ...content } = input;
  if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))
    throw createError({ statusCode: 400, statusMessage: '保存请求编号无效' });
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const db = getDatabase();
  return runInTransaction(db, () => {
    const previous = db.prepare(`SELECT member_id AS memberId,content_hash AS hash,response_json AS response FROM health_workflow_requests
      WHERE user_id=? AND scope=? AND request_key=? ORDER BY CASE WHEN member_id=? THEN 0 ELSE 1 END LIMIT 1`).get(user.id, scope, requestKey, memberId) as
      { memberId:string; hash: string; response: string } | undefined;
    if (previous) {
      if(previous.memberId!==memberId)throw createError({statusCode:409,statusMessage:'记录所属成员已变化，请刷新后重新核对'});
      if (previous.hash !== hash) throw createError({ statusCode: 409, statusMessage: '重试内容已变化，请重新确认后保存' });
      const saved = JSON.parse(previous.response) as T;
      const current = readSaved ? readSaved(saved) : saved;
      if (current && typeof current === 'object' && 'memberId' in current && current.memberId !== memberId)
        throw createError({ statusCode: 409, statusMessage: '已保存记录的成员归属发生变化，请刷新后查看' });
      return current;
    }
    const result = create();
    db.prepare(`INSERT INTO health_workflow_requests(user_id,member_id,scope,request_key,content_hash,response_json)
      VALUES(?,?,?,?,?,?)`).run(user.id, memberId, scope, requestKey, hash, JSON.stringify(result));
    return result;
  });
}
