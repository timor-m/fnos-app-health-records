import { defineEventHandler, readBody } from "h3";
import { setLocalAccountDisabled } from "../../../../services/auth.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  return ok(setLocalAccountDisabled(getRequestUser(event), (await readBody(event)) || {}));
});
