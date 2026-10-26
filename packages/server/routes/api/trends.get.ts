import { createError, defineEventHandler, getQuery } from "h3";
import { readLegacyTrendSnapshot } from "../../services/trend-snapshot-query.service";
import { trendResponse } from "../../utils/trend-response";
import { getRequestUser } from "../../utils/request-user";
import { filterTrendGroups } from '../../services/trend-groups.service';
import { trendFilterKeys } from '../../utils/trend-filter-query';

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const user = getRequestUser(event);
  if (!user.authenticated) {
    if (query.includeGroups === 'true') throw createError({statusCode:401,statusMessage:'请先登录'});
    return trendResponse(event, []);
  }
  if (typeof query.memberId !== 'string' || !query.memberId) throw createError({statusCode:400,statusMessage:'请选择成员'});
  const groups = trendFilterKeys(query, 'groupKeys');
  const indicators = trendFilterKeys(query, 'indicatorKeys');
  const {series,groups:tree} = readLegacyTrendSnapshot(user, query.memberId);
  const filtered = !groups.length && !indicators.length ? series : filterTrendGroups(series, tree, groups, indicators);
  return trendResponse(event, query.includeGroups === 'true' ? {series:filtered,groups:tree} : filtered);
});
