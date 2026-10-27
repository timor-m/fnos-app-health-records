import { createError, defineEventHandler, getQuery, setHeader } from "h3";
import { findAiProfile, parseStoredSettings } from "../../../services/ai-settings.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
import { isAdministrator } from "../../../domain/request-user";

export default defineEventHandler(event => {
  if (!isAdministrator(getRequestUser(event))) throw createError({ statusCode: 403, statusMessage: "仅管理员可编辑 AI 请求头" });
  setHeader(event, "cache-control", "private, no-store");
  const profileId = getQuery(event).profileId;
  if (typeof profileId !== "string" || !profileId.trim()) throw createError({ statusCode: 400, statusMessage: "请选择连接配置" });
  const profile = findAiProfile(parseStoredSettings(), profileId);
  if (!profile) throw createError({ statusCode: 404, statusMessage: "连接配置不存在" });
  return ok(Object.entries(profile.headers).map(([name, value]) => ({ name, value, configured: true })));
});
