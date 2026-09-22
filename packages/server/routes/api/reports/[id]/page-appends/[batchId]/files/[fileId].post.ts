import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../../../../utils/request-user";
import { ok } from "../../../../../../../utils/api-response";
import { readUploadFile } from "../../../../../../../utils/read-upload-file";
import {
  storePageAppendFile,
  getPageAppend,
} from "../../../../../../../services/page-append.service";
export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  getPageAppend(
    user,
    getRouterParam(event, "id") || "",
    getRouterParam(event, "batchId") || "",
  );
  const file = await readUploadFile(event);
  return ok(
    storePageAppendFile(
      user,
      getRouterParam(event, "id") || "",
      getRouterParam(event, "batchId") || "",
      getRouterParam(event, "fileId") || "",
      new Uint8Array(await file.arrayBuffer()),
    ),
  );
});
