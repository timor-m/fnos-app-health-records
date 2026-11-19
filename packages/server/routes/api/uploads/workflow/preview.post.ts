import { createError, defineEventHandler, readBody } from 'h3';
import { previewUploadWorkflow } from '../../../../services/health-upload-workflow.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event => {
  const body=await readBody<{memberId?:unknown;reportIds?:unknown}>(event);
  if(typeof body?.memberId!=='string') throw createError({statusCode:400,statusMessage:'请选择成员'});
  return ok(previewUploadWorkflow(getRequestUser(event),body.memberId,body.reportIds));
});
