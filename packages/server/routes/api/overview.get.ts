import { queueHealthProcessOrganization } from '../../services/health-process-ai.service';
import { createError, defineEventHandler, getQuery } from "h3";
import { getOverview } from "../../services/health-overview.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  if(typeof memberId!=='string'||!memberId)throw createError({statusCode:400,statusMessage:'成员无效'});
  const user=getRequestUser(event);const overview=getOverview(user,memberId);queueHealthProcessOrganization(user,overview.processes.map(p=>p.id));return ok(overview);
});
