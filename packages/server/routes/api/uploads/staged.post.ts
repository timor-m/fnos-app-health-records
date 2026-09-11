import { defineEventHandler, readBody } from 'h3';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
import { startStagedUpload } from '../../../services/staged-upload.service';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  const body = await readBody<Parameters<typeof startStagedUpload>[2] & { requestKey: string }>(event);
  return ok(startStagedUpload(user, body?.requestKey || '', body!));
});
