import { defineEventHandler, getRouterParam } from 'h3';
import { assertReportNoteAccess, stageReportNoteImage } from '../../../../../services/report-note.service';
import { getRequestUser } from '../../../../../utils/request-user';
import { readUploadFile } from '../../../../../utils/read-upload-file';
import { ok } from '../../../../../utils/api-response';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  const reportId = getRouterParam(event, 'id') || '';
  assertReportNoteAccess(user, reportId, true);
  const file = await readUploadFile(event);
  return ok(await stageReportNoteImage(user, reportId, { originalName: file.name, declaredType: file.type, data: new Uint8Array(await file.arrayBuffer()) }));
});
