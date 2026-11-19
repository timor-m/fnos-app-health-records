import { createError, defineEventHandler } from 'h3';
import { withMultipartUpload } from '../../../utils/read-multipart-upload';
import { maxUploadFileBytes } from '../../../../shared/upload-limits';
import { getRequestUser } from '../../../utils/request-user';
import { requireAuthenticated } from '../../../services/member.service';
import { saveVaccinationWithOriginal } from '../../../services/vaccination-original.service';
import { ok } from '../../../utils/api-response';

export default defineEventHandler(async event => {
  const user = getRequestUser(event); requireAuthenticated(user);
  return withMultipartUpload(event,{requestBytes:205*1024*1024,fileBytes:maxUploadFileBytes,files:1000,
    sizeMessage:'单文件上限 40 MB，单次请求上限 205 MB'},({fields,files}) => {
    let input: Record<string,unknown>;
    try {
      const value = JSON.parse(fields.payload || '');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      input = value;
    } catch { throw createError({statusCode:400,statusMessage:'接种信息无效，请重新保存'}); }
    return ok(saveVaccinationWithOriginal(user,input,files.filter(file => file.name==='files' && file.filename)
      .map(file => ({originalName:file.filename,sourcePath:file.path}))));
  });
});
