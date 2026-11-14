import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { createMorphologyFinding } from "../../../../services/morphology-finding.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少报告 ID" });
  return ok(createMorphologyFinding(getRequestUser(event), id, await readBody(event) || {}));
});
