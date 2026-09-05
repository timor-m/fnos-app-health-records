import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";
import { getAppConfig } from "../../utils/runtime-config";
import { localAuthSetupRequired } from "../../services/auth.service";
import { isAdministrator } from "../../domain/request-user";

export default defineEventHandler((event) => {
  const config = getAppConfig();
  const user = getRequestUser(event);
  return ok({
    ...user,
    appName: config.appName,
    isAdmin: isAdministrator(user),
    mustChangePassword: Boolean(user.mustChangePassword),
    authMode: config.authMode,
    setupRequired: config.authMode === "local" && localAuthSetupRequired()
  });
});
