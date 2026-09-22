import { createError, defineEventHandler } from "h3";
import { restoreUploadedBackup,preflightRestore } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";
import { withMultipartUpload } from "../../../utils/read-multipart-upload";

const maxUploadedBackupBytes = 1024 * 1024 * 1024;

export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  if (!isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: "仅管理员可恢复备份" });
  return withMultipartUpload(event, {
    requestBytes: maxUploadedBackupBytes, fileBytes: maxUploadedBackupBytes, files: 1,
    sizeMessage: "备份文件大小超过限制（最大 1024MB）"
  }, ({ files,fields }) => {
    const backup = files.find(part => (part.name === "backup" || part.name === "file") && part.filename);
    if (!backup) throw createError({ statusCode: 400, statusMessage: "请选择备份文件" });
    if (!/\.tar\.gz$/i.test(backup.filename)) throw createError({ statusCode: 400, statusMessage: "仅支持 .tar.gz 完整应用备份" });
    return ok(fields.token ? { ...restoreUploadedBackup(user, backup.path,fields.token), filename: backup.filename } : preflightRestore(user,backup.path));
  });
});
