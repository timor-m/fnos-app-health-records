import { defineEventHandler, getRouterParam, readBody } from "h3";
import { getRequestUser } from "../../../../../utils/request-user";
import { ok } from "../../../../../utils/api-response";
import { importPageAppendFiles } from "../../../../../services/page-append.service";
export default defineEventHandler(async (event) =>
  ok(
    await importPageAppendFiles(
      getRequestUser(event),
      getRouterParam(event, "id") || "",
      (await readBody<Parameters<typeof importPageAppendFiles>[2]>(event))!,
    ),
  ),
);
