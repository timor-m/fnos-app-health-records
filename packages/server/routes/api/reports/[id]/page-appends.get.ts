import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../utils/request-user";
import { ok } from "../../../../utils/api-response";
import { latestPageAppend } from "../../../../services/page-append.service";
export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "private, no-store");
  return ok(
    latestPageAppend(getRequestUser(event), getRouterParam(event, "id") || ""),
  );
});
