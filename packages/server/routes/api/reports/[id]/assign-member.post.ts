import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { assignReportMember } from "../../../../services/report-member-identity.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const body = (await readBody(event)) as Record<string, unknown> | null;
  const memberId = typeof body?.memberId === "string" ? body.memberId.trim() : "";
  const newMember = body?.newMember;
  if (memberId) return ok(assignReportMember(getRequestUser(event), reportId, { memberId }));
  if (
    newMember &&
    typeof newMember === "object" &&
    !Array.isArray(newMember) &&
    typeof (newMember as Record<string, unknown>).displayName === "string" &&
    typeof (newMember as Record<string, unknown>).relationship === "string"
  ) {
    const input = newMember as Record<string, unknown>;
    return ok(
      assignReportMember(getRequestUser(event), reportId, {
        newMember: {
          displayName: input.displayName as string,
          relationship: input.relationship as string,
          sex: typeof input.sex === "string" ? input.sex : null,
          birthDate: typeof input.birthDate === "string" ? input.birthDate : null,
        },
      }),
    );
  }
  throw createError({ statusCode: 400, statusMessage: "请选择要归属的成员或填写新成员信息" });
});
