import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createError, defineEventHandler, getRouterParam, sendStream, setHeader } from "h3";
import { getReportPageOriginalDownload } from "../../../../../../services/records.service";
import { getRequestUser } from "../../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  const pageId = getRouterParam(event, "pageId");
  if (!reportId || !pageId) throw createError({ statusCode: 400, statusMessage: "报告页面 ID 无效" });
  const file = await getReportPageOriginalDownload(getRequestUser(event), reportId, pageId);
  setHeader(event, "content-type", file.mimeType);
  setHeader(event, "content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  setHeader(event, "cache-control", "private, no-store");
  return sendStream(event, Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream);
});
