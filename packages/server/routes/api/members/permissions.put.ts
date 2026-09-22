import { defineEventHandler, readBody } from "h3";
import { setMembersPermission } from "../../../services/member.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async event =>
  ok(setMembersPermission(getRequestUser(event), (await readBody(event)) || {}))
);
