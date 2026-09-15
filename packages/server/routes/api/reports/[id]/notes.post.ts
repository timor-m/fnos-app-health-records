import { defineEventHandler, getRouterParam, readBody } from 'h3';
import { saveReportNote } from '../../../../services/report-note.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event => ok(saveReportNote(getRequestUser(event), getRouterParam(event, 'id') || '', await readBody(event))));
