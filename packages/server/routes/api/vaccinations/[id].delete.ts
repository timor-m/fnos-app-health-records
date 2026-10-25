import { createError, defineEventHandler, getRouterParam, readBody, getQuery } from 'h3';
import { permanentlyDeleteVaccination } from '../../../services/health-record-trash.service';
import { deleteVaccination } from '../../../services/vaccination.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{const id=getRouterParam(event,'id',{decode:true});if(!id)throw createError({statusCode:400,statusMessage:'接种编号无效'});const input=await readBody<Record<string,unknown>>(event)||{};return ok(getQuery(event).permanent==='1'?permanentlyDeleteVaccination(getRequestUser(event),id,input):deleteVaccination(getRequestUser(event),id,input));});
