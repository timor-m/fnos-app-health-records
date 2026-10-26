import { createError, defineEventHandler, getQuery } from 'h3';
import { queryTrendSnapshotSeries } from '../../../services/trend-snapshot-query.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';

export default defineEventHandler(event => {
  const user = getRequestUser(event);
  const { memberId } = getQuery(event);
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: '请先登录' });
  if (typeof memberId !== 'string' || !memberId) throw createError({ statusCode: 400, statusMessage: '请选择成员' });
  return ok(queryTrendSnapshotSeries(user, memberId, {limit:1}).groups);
});
