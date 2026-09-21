import { apiError } from "../../../utils/api-error";
import { defineEventHandler, readBody } from 'h3';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
import { startStagedUpload } from '../../../services/staged-upload.service';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  let body: (Parameters<typeof startStagedUpload>[2] & { requestKey: string }) | undefined;
  try { body = await readBody(event); }
  catch { throw apiError(400, 'UPLOAD_INVALID', '上传数据读取失败，请重新选择文件后重试'); }
  return ok(startStagedUpload(user, body?.requestKey || '', body!));
});
