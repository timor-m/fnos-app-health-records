import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateAppNotificationStatus } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const notificationId = getRouterParam(event, "id");
  if (!notificationId) throw createError({ statusCode: 400, statusMessage: "通知 ID 无效" });
  const body = await readBody(event) as { status?: string };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createError({ statusCode: 400, statusMessage: "请求内容必须为对象" });
  }
  return ok(updateAppNotificationStatus(getRequestUser(event), notificationId, String(body.status || "")));
});
