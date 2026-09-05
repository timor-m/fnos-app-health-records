import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { defineEventHandler, getQuery, sendStream, setHeader } from "h3";
import { getLocalImportPreviewFileForUser } from "../../../services/local-file-import.service";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  const query = getQuery(event);
  const file = await getLocalImportPreviewFileForUser(user, query.rootId, query.path, query.variant);
  setHeader(event, "content-type", file.mimeType);
  setHeader(event, "content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  setHeader(event, "cache-control", "private, max-age=300");
  return sendStream(event, Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream);
});
