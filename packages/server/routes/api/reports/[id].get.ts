import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { getReportDetail } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  return ok(getReportDetail(getRequestUser(event), reportId, {
    includeDuplicateCandidates: getQuery(event).includeDuplicateCandidates !== 'false'
  }));
});
