import { defineEventHandler, getQuery } from "h3";
import {
  countIndicatorGovernanceHistory,
  listIndicatorGovernanceHistory
} from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 100;
  const offset = typeof query.offset === "string" ? Number.parseInt(query.offset, 10) : 0;
  const user = getRequestUser(event);
  return ok({
    items: listIndicatorGovernanceHistory(user, limit, offset),
    total: countIndicatorGovernanceHistory(user)
  });
});
