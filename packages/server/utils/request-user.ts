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
  const db = getDatabase();
  const previous = db.prepare(`
    SELECT display_name AS displayName, is_gateway_admin AS isAdmin FROM users WHERE id = ?
  `).get(user.id) as { displayName: string; isAdmin: number } | undefined;
  const identity = db.prepare(`SELECT user_id AS userId FROM user_identities WHERE provider = ? AND subject = ?`)
    .get(user.provider, user.id) as { userId: string } | undefined;
  const selfMember = db.prepare(`
    SELECT 1 FROM health_members hm JOIN member_permissions mp ON mp.member_id = hm.id
    WHERE mp.user_id = ? AND hm.relationship = 'self' AND hm.deleted_at IS NULL
  `).get(user.id);
  const changed = !previous || previous.displayName !== user.displayName || previous.isAdmin !== Number(isAdministrator(user));
  if (!changed && identity?.userId === user.id && selfMember) return;

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
    `).run(createId("identity"), user.id, user.provider, user.id);
    if (previous && previous.displayName !== user.displayName) {
      // Heal the old gateway name, preserving manually renamed self members.
      db.prepare(`UPDATE health_members SET display_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE relationship = 'self' AND created_by = ? AND display_name = ? AND deleted_at IS NULL
      `).run(user.displayName, user.id, previous.displayName);
    }
    if (!selfMember) {
      const memberId = createId("member");
      db.prepare(`INSERT INTO health_members (id, display_name, relationship, created_by)
        VALUES (?, ?, 'self', ?)`).run(memberId, user.displayName, user.id);
      db.prepare(`INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES (?, ?, 'manager', ?)`).run(memberId, user.id, user.id);
    }
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
