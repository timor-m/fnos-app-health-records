import { defineEventHandler, getQuery } from "h3";
import { listTrendSeries } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";
import { buildTrendGroupTree, filterTrendGroups } from '../../services/trend-groups.service';
import { trendFilterKeys } from '../../utils/trend-filter-query';

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const user = getRequestUser(event);
  const groups = trendFilterKeys(query, 'groupKeys');
  const indicators = trendFilterKeys(query, 'indicatorKeys');
  const series = listTrendSeries(user, typeof query.memberId === 'string' ? query.memberId : undefined);
  if (!groups.length && !indicators.length) return ok(series);
  return ok(filterTrendGroups(series, buildTrendGroupTree(series, user.id), groups, indicators));
});
