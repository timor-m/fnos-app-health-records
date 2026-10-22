import { createError, defineEventHandler, setHeader } from 'h3';
import { getWechatGroup } from '../../services/wechat-group.service';
import { ok } from '../../utils/api-response';
import { getRequestUser } from '../../utils/request-user';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  if (!getRequestUser(event).authenticated) throw createError({ statusCode: 401, statusMessage: '请先登录应用' });
  return ok(await getWechatGroup());
});
