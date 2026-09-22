import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../../../../utils/request-user";
import { ok } from "../../../../../../../utils/api-response";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { sendStream } from "h3";
import { pageAppendPreview } from "../../../../../../../services/page-append.service";
export default defineEventHandler((event) => {
  const path = pageAppendPreview(
    getRequestUser(event),
    getRouterParam(event, "id") || "",
    getRouterParam(event, "batchId") || "",
    getRouterParam(event, "pageId") || "",
  );
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "content-type", "image/jpeg");
  return sendStream(
    event,
    Readable.toWeb(createReadStream(path)) as unknown as ReadableStream,
  );
});
