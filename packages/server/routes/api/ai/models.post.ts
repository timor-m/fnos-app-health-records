import {createError, defineEventHandler, readBody} from "h3";
import {listAiModels} from "../../../services/ai-models.service";
import {ok} from "../../../utils/api-response";
import {getRequestUser} from "../../../utils/request-user";
import {isAdministrator} from "../../../domain/request-user";

export default defineEventHandler(async event => {
  if (!isAdministrator(getRequestUser(event))) throw createError({statusCode:403,statusMessage:"仅管理员可获取模型列表"});
  return ok(await listAiModels(await readBody(event)));
});
