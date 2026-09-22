import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../../../utils/request-user";
import { ok } from "../../../../../../utils/api-response";
import { retryPageAppend } from "../../../../../../services/page-append.service";
export default defineEventHandler(async (event) =>
  ok(
    retryPageAppend(
      getRequestUser(event),
      getRouterParam(event, "id") || "",
      getRouterParam(event, "batchId") || "",
      (await readBody<{ keepOcr?: boolean }>(event))?.keepOcr === true,
    ),
  ),
);
