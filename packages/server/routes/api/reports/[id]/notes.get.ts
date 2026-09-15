import { defineEventHandler, getRouterParam } from 'h3';
import { listReportNotes } from '../../../../services/report-note.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event => ok(listReportNotes(getRequestUser(event), getRouterParam(event, 'id') || '')));
