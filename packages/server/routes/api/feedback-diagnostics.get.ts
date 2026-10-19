import { createError, defineEventHandler, setHeader } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getFeedbackDiagnostics } from "../../services/feedback-diagnostics.service";

export default defineEventHandler((event) => {
  if (!getRequestUser(event).authenticated) throw createError({statusCode:401,statusMessage:"请先登录应用"});
  setHeader(event, "Cache-Control", "no-store");
  return ok(getFeedbackDiagnostics(getRequestAccessMode(event)));
});
