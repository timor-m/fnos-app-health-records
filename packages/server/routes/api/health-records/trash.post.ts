import {mutateHealthProcessTrash} from '../../../services/health-process-trash.service';
import { createError,defineEventHandler,readBody } from 'h3';
import { mutateStandaloneTrash,standaloneTrashKinds } from '../../../services/health-record-trash.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{
 const body=await readBody<Record<string,unknown>>(event);
 if(!body || !(body.kind==='process'||standaloneTrashKinds.includes(body.kind as typeof standaloneTrashKinds[number])) || typeof body.id!=='string' || !body.id.trim() || body.id.length>200 || !['trash','restore','purge'].includes(String(body.operation)))throw createError({statusCode:400,statusMessage:'回收站操作无效'});
 if(body.kind==='process'){if(body.operation==='trash')throw createError({statusCode:400,statusMessage:'请从历程详情移入回收站'});return ok(mutateHealthProcessTrash(getRequestUser(event),body.id,body,body.operation as 'restore'|'purge'));}
 return ok(mutateStandaloneTrash(getRequestUser(event),body.kind as typeof standaloneTrashKinds[number],body.id,body,body.operation as 'trash'|'restore'|'purge'));
});
