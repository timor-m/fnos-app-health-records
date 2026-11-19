import { createError, defineEventHandler, readBody } from 'h3';
import type { AssociationInput } from '../../../../shared/health-record-associations';
import { changeRecordAssociations } from '../../../services/health-record-association.service';
import { getRequestUser } from '../../../utils/request-user';
import { queueHealthProcessOrganization } from '../../../services/health-process-ai.service';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{
  const input=await readBody<AssociationInput&{requestKey?:string}>(event);
  if(!input||typeof input!=='object'||Array.isArray(input))throw createError({statusCode:400,statusMessage:'关联内容无效'});
  const user=getRequestUser(event);
  const result=changeRecordAssociations(user,input);queueHealthProcessOrganization(user,result.processes.map(p=>p.id));return ok(result);
});
