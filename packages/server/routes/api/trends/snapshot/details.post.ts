import { defineEventHandler, readBody, createError } from 'h3';
import { readTrendSnapshotParts } from '../../../../services/trend-snapshot-query.service';
import { getRequestUser } from '../../../../utils/request-user';
import { snapshotQuery } from '../../../../utils/trend-snapshot-query';
import { trendResponse } from '../../../../utils/trend-response';
export default defineEventHandler(async event => {
  const raw = await readBody(event);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw createError({statusCode:400,statusMessage:'趋势读取参数无效'});
  const body = raw as Record<string,unknown>;
  const keys = body.keys;
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string')) throw createError({statusCode:400,statusMessage:'趋势指标参数无效'});
  const {memberId,filters} = snapshotQuery(body);
  return trendResponse(event,readTrendSnapshotParts(getRequestUser(event),memberId,filters.version!,keys,'detail'));
});
