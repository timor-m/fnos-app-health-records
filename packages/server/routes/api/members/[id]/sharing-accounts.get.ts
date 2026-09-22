import { defineEventHandler, getRouterParam } from "h3";
import { listMemberSharingAccounts } from "../../../../services/member.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(event =>
  ok(listMemberSharingAccounts(getRequestUser(event), getRouterParam(event, "id") || ""))
);
