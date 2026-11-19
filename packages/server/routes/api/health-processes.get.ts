import { createError,defineEventHandler,getQuery } from 'h3';
import { listRecordProcesses,listRecordProcessPage } from '../../services/health-record-process.service';
import { queueHealthProcessOrganization } from '../../services/health-process-ai.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';
export default defineEventHandler(event=>{const query=getQuery(event);const memberId=query.memberId;if(typeof memberId!=='string'||!memberId)throw createError({statusCode:400,statusMessage:'请选择成员'});
 for(const key of ['limit','cursor','q'])if(query[key]!==undefined&&typeof query[key]!=='string')throw createError({statusCode:400,statusMessage:'查询参数无效'});
 const user=getRequestUser(event);
 if(query.limit!==undefined||query.cursor!==undefined||query.q!==undefined){const page=listRecordProcessPage(user,memberId,{limit:query.limit===undefined?20:Number(query.limit),cursor:query.cursor as string|undefined,query:query.q as string|undefined});queueHealthProcessOrganization(user,page.items.map(p=>p.id));return ok(page);}
 const processes=listRecordProcesses(user,memberId);queueHealthProcessOrganization(user,processes.map(p=>p.id));return ok(processes);});
