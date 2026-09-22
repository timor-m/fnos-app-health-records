import { createError, defineEventHandler, getRouterParam,readBody } from "h3";
import { restoreBackup } from "../../../../services/records.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "备份 ID 无效" });
  return ok(restoreBackup(getRequestUser(event), id,(await readBody<{token?:string}>(event))?.token));
});
