import { defineEventHandler, getQuery } from "h3";
import { listLocalImportDirectoryForUser } from "../../services/local-file-import.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler(async (event) => {
  const user = getRequestUser(event);
  const query = getQuery(event);
  return ok(await listLocalImportDirectoryForUser(user, query.rootId, query.path));
});
