import { defineEventHandler, readBody, getRouterParam } from "h3";
import { updateAccountPreferences } from "../../../services/member-preferences.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";
export default defineEventHandler(async event => { return ok(updateAccountPreferences(getRequestUser(event),(await readBody(event)) || {})); });
