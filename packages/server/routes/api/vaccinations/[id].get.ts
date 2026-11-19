import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { getVaccination } from '../../../services/vaccination.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{const id=getRouterParam(event,'id');if(!id)throw createError({statusCode:400,statusMessage:'接种编号无效'});return ok(getVaccination(getRequestUser(event),id));});
