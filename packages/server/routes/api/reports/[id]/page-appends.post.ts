import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../utils/request-user";
import { ok } from "../../../../utils/api-response";
import { startPageAppend } from "../../../../services/page-append.service";
export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "private, no-store");
  return ok(
    startPageAppend(
      getRequestUser(event),
      getRouterParam(event, "id") || "",
      (await readBody<Parameters<typeof startPageAppend>[2]>(event))!,
    ),
  );
});
