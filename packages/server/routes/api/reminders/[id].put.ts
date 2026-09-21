import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateReminderStatus } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reminderId = getRouterParam(event, "id");
  if (!reminderId) throw createError({ statusCode: 400, statusMessage: "提醒 ID 无效" });
  const body = await readBody(event) as { status?: string };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createError({ statusCode: 400, statusMessage: "请求内容必须为对象" });
  }
  return ok(updateReminderStatus(getRequestUser(event), reminderId, String(body.status || "")));
});
