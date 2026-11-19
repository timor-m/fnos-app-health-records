import { createError, defineEventHandler, getQuery } from 'h3';
import { listVaccinations } from '../../services/vaccination.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';
export default defineEventHandler(event=>{const {memberId}=getQuery(event);if(typeof memberId!=='string'||!memberId)throw createError({statusCode:400,statusMessage:'成员无效'});return ok(listVaccinations(getRequestUser(event),memberId));});
