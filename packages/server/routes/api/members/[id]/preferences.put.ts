import { defineEventHandler, readBody, getRouterParam } from "h3";
import { setMemberHidden } from "../../../../services/member-preferences.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";
export default defineEventHandler(async event => { return ok(setMemberHidden(getRequestUser(event),getRouterParam(event,"id") || "",(await readBody<Record<string,unknown>>(event))?.hidden)); });
