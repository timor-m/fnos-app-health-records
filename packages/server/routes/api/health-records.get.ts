import { createError, defineEventHandler, getQuery } from 'h3';
import { listHealthRecordFeed } from '../../services/health-record-feed.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';
export default defineEventHandler(event=>{
 const query=getQuery(event);if(typeof query.memberId!=='string'||!query.memberId)throw createError({statusCode:400,statusMessage:'成员无效'});
 for(const key of ['category','subtype','status','q','cursor','timeZone'])if(query[key]!==undefined && typeof query[key]!=='string')throw createError({statusCode:400,statusMessage:'查询参数无效'});
 return ok(listHealthRecordFeed(getRequestUser(event),{memberId:query.memberId,category:query.category as string|undefined,status:query.status as string|undefined,subtype:query.subtype as string|undefined,query:query.q as string|undefined,cursor:query.cursor as string|undefined,timeZone:query.timeZone as string|undefined}));
});
