import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import { importAuthorizedFnosFiles, importLocalFilesForUser } from "../../../services/local-file-import.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  const body = (await readBody(event)) as {
    memberId?: unknown;
    files?: Array<{ rootId?: unknown; path?: unknown; rotation?: unknown }>;
    authorizedPaths?: unknown;
  } | null;
  const memberId = String(body?.memberId || "").trim();
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "请选择报告所属成员" });
  const result = Array.isArray(body?.authorizedPaths)
    ? await importAuthorizedFnosFiles(user, memberId, body.authorizedPaths)
    : await importLocalFilesForUser(user, memberId, body?.files || []);
  setResponseStatus(event, 201);
  return ok(result);
});
