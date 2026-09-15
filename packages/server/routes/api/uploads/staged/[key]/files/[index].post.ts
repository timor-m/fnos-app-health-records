import { defineEventHandler, getRouterParam } from 'h3';
import { getRequestUser } from '../../../../../../utils/request-user';
import { ok } from '../../../../../../utils/api-response';
import { readUploadFile } from '../../../../../../utils/read-upload-file';
import { storeStagedFile } from '../../../../../../services/staged-upload.service';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  const file = await readUploadFile(event);
  return ok(storeStagedFile(user, getRouterParam(event, 'key') || '', Number(getRouterParam(event, 'index')), new Uint8Array(await file.arrayBuffer())));
});
