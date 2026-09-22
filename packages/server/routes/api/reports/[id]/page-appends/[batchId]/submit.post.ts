import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../../../utils/request-user";
import { ok } from "../../../../../../utils/api-response";
import { submitPageAppend } from "../../../../../../services/page-append.service";
export default defineEventHandler(async (event) =>
  ok(
    submitPageAppend(
      getRequestUser(event),
      getRouterParam(event, "id") || "",
      getRouterParam(event, "batchId") || "",
      (await readBody<{ pages: Parameters<typeof submitPageAppend>[3] }>(event))
        ?.pages || [],
    ),
  ),
);
