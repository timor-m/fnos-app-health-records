import { getDeploymentIdentity } from "./deployment-identity";
import type { H3Event } from "h3";
import { getDatabase, runInTransaction } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "./identifier";
import { decodeGatewayHeaderValue } from "./gateway-user";
import { getAppConfig } from "./runtime-config";
import { getLocalSessionUser } from "../services/auth.service";

function requestAccessMode(event: H3Event) {
  const request = event.node!.req!;
  return (request as typeof request & { healthAccessMode?: string }).healthAccessMode;
}

function ensureUser(user: RequestUser) {
  const externalSubject = user.id;
  const subject = `${getDeploymentIdentity().identityDomain}:${externalSubject}`;
  const db = getDatabase();
  const mapped = db.prepare(`SELECT i.user_id AS id FROM user_identities i WHERE i.provider=? AND i.subject IN (?,?)
    AND NOT EXISTS(SELECT 1 FROM identity_recovery_pending r WHERE r.user_id=i.user_id)
    ORDER BY CASE WHEN i.subject=? THEN 0 ELSE 1 END LIMIT 1`).get(user.provider,subject,externalSubject,subject) as {id:string}|undefined;
  user.id = mapped?.id || createId('user');
  const previous = db.prepare(`
    SELECT display_name AS displayName, is_gateway_admin AS isAdmin FROM users WHERE id = ?
  `).get(user.id) as { displayName: string; isAdmin: number } | undefined;
  const identity = db.prepare(`SELECT user_id AS userId FROM user_identities WHERE provider = ? AND subject = ?`)
    .get(user.provider, subject) as { userId: string } | undefined;
  const changed = !previous || previous.displayName !== user.displayName || previous.isAdmin !== Number(isAdministrator(user));
  if (!changed && identity?.userId === user.id) return;

  // Identity and initial member permissions must either all persist or all roll back.
  runInTransaction(db, () => {
    if (changed) db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
        is_gateway_admin = excluded.is_gateway_admin, updated_at = CURRENT_TIMESTAMP
    `).run(user.id, user.displayName, Number(isAdministrator(user)));
    if (identity?.userId !== user.id) db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id
    `).run(createId("identity"), user.id, user.provider, subject);

  });
}

export function gatewayUser(event: H3Event): RequestUser | null {
  if (getAppConfig().authMode !== "fnos" || requestAccessMode(event) !== "gateway") return null;
  const request = event.node!.req!;
  const uid = request.headers["x-trim-userid"];
  if (typeof uid !== "string" || !uid.trim()) return null;
  const username = request.headers["x-trim-username"];
  const isAdmin = String(request.headers["x-trim-isadmin"] || "").toLowerCase() === "true";
  const displayName = typeof username === "string" ? decodeGatewayHeaderValue(username).trim() : "";
  return {
    id: uid.trim(),
    displayName: displayName || uid.trim(),
    provider: "fnos_gateway",
    authenticated: true,
    isAdmin,
    isGatewayAdmin: isAdmin
  };
}

export function getRequestUser(event: H3Event): RequestUser {
  if (event.context?.requestUser) return event.context.requestUser as RequestUser;
  const user = resolveRequestUser(event);
  if (event.context) event.context.requestUser = user;
  return user;
}

function resolveRequestUser(event: H3Event): RequestUser {
  const resolved = gatewayUser(event);
  if (resolved) {
    ensureUser(resolved);
    return resolved;
  }

  const local = getLocalSessionUser(event);
  if (local) return local;

  if (process.env.NODE_ENV === "development" || Boolean(process.env.VITE_DEV_SERVER_URL)) {
    const developmentUser: RequestUser = {
      id: "local-development-owner",
      displayName: "开发管理员",
      provider: "development",
      authenticated: true,
      isAdmin: true,
      isGatewayAdmin: true
    };
    ensureUser(developmentUser);
    return developmentUser;
  }

  return {
    id: "anonymous",
    displayName: "未登录",
    provider: getAppConfig().authMode === "local" ? "local" : "fnos_gateway",
    authenticated: false,
    isAdmin: false,
    isGatewayAdmin: false
  };
}
