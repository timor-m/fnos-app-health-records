import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { getRequestUser } from "../../../../../utils/request-user";
import { ok } from "../../../../../utils/api-response";
import { cancelPageAppend } from "../../../../../services/page-append.service";
export default defineEventHandler((event) => {
  setHeader(event, "cache-control", "private, no-store");
  return ok(
    cancelPageAppend(
      getRequestUser(event),
      getRouterParam(event, "id") || "",
      getRouterParam(event, "batchId") || "",
    ),
  );
});
