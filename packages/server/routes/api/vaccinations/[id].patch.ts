import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import { updateVaccination } from '../../../services/vaccination.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(async event=>{const id=getRouterParam(event,'id');if(!id)throw createError({statusCode:400,statusMessage:'接种编号无效'});return ok(updateVaccination(getRequestUser(event),id,await readBody(event)||{}));});
