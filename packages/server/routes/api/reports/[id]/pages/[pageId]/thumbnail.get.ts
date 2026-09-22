import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "h3";
import { getReportPageFile } from "../../../../../../services/records.service";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  const pageId = getRouterParam(event, "pageId");
  if (!reportId || !pageId) throw createError({ statusCode: 400, statusMessage: "报告页面 ID 无效" });
  const file = getReportPageFile(getRequestUser(event), reportId, pageId, "thumbnail");
  setHeader(event, "content-type", file.mimeType);
  setHeader(event, "cache-control", "private, no-store");
  return sendStream(event, Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream);
});
