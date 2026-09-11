import { defineEventHandler, getRouterParam } from 'h3';
import { getRequestUser } from '../../../../../utils/request-user';
import { ok } from '../../../../../utils/api-response';
import { completeStagedUpload } from '../../../../../services/staged-upload.service';
export default defineEventHandler(event => ok(completeStagedUpload(getRequestUser(event), getRouterParam(event, 'key') || '')));
