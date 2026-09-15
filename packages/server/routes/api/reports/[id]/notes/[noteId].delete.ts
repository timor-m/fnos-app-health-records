import { defineEventHandler, getRouterParam } from 'h3';
import { deleteReportNote } from '../../../../../services/report-note.service';
import { getRequestUser } from '../../../../../utils/request-user';
import { ok } from '../../../../../utils/api-response';
export default defineEventHandler(event => ok(deleteReportNote(getRequestUser(event), getRouterParam(event, 'id') || '', getRouterParam(event, 'noteId') || '')));
