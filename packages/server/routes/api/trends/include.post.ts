import { defineEventHandler, readBody } from "h3";
import { includeObservationInTrend } from "../../../services/observation-field-overrides.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({})) as Record<string, unknown>;
  const reportId = typeof body.reportId === "string" ? body.reportId : "";
  const observationId = typeof body.observationId === "string" ? body.observationId : "";
  return ok(includeObservationInTrend(getRequestUser(event), reportId, observationId, body || {}));
});
