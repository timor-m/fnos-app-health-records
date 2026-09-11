import { createError, defineEventHandler, getRouterParam } from "h3";
import { cancelReportProcessing } from "../../../../services/job-runner.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  return ok(cancelReportProcessing(getRequestUser(event), reportId));
});
