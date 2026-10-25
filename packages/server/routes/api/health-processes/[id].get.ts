import { defineEventHandler,getRouterParam } from 'h3';
import { getRecordProcess } from '../../../services/health-record-process.service';
import { queueHealthProcessOrganization } from '../../../services/health-process-ai.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{const user=getRequestUser(event);const id=getRouterParam(event,'id')||'';const process=getRecordProcess(user,id);if(process.aiState==='idle'||process.aiState==='stale')setImmediate(()=>queueHealthProcessOrganization(user,[id]));return ok(process);});
