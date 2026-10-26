import { defineEventHandler, getQuery } from 'h3';
import { queryTrendSnapshotSeries } from '../../../../services/trend-snapshot-query.service';
import { getRequestUser } from '../../../../utils/request-user';
import { snapshotQuery } from '../../../../utils/trend-snapshot-query';
import { trendResponse } from '../../../../utils/trend-response';
export default defineEventHandler(event => {
  const {memberId,filters} = snapshotQuery(getQuery(event));
  return trendResponse(event,queryTrendSnapshotSeries(getRequestUser(event),memberId,filters));
});
