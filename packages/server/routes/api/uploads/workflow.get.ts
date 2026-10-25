import { createError, defineEventHandler, getQuery } from 'h3';
import { listUploadWorkflow } from '../../../services/health-upload-workflow.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event => {
  const {memberId,cursor}=getQuery(event);
  if(typeof memberId!=='string'||(cursor!==undefined&&typeof cursor!=='string')) throw createError({statusCode:400,statusMessage:'成员或分页信息无效'});
  return ok(listUploadWorkflow(getRequestUser(event),memberId,cursor));
});
