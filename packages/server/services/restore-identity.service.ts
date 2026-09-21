import { rollbackAfterError, getDatabase } from "../database/client";
import { isAdministrator, type RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";

export type RestoredLocalCredential = {
  username: string;
  passwordHash: string;
  passwordSalt: string;
};

export function captureRestoringAdministratorCredential(user: RequestUser): RestoredLocalCredential | null {
  if (user.provider !== "local") return null;
  const credential = getDatabase().prepare(`
    SELECT username, password_hash AS passwordHash, password_salt AS passwordSalt
    FROM local_accounts WHERE user_id = ? AND disabled_at IS NULL
  `).get(user.id) as RestoredLocalCredential | undefined;
  if (!credential) throw new Error("当前本地管理员凭据不存在，无法安全恢复备份");
  return credential;
}

export function rebindRestoredAdministrator(
  user: RequestUser,
  localCredential: RestoredLocalCredential | null = null
) {
  if (!user.authenticated || !isAdministrator(user) || !["fnos_gateway", "local", "development"].includes(user.provider)) {
    throw new Error("恢复后的身份接管需要当前部署的系统管理员");
  }
  if (user.provider === "local" && !localCredential) {
    throw new Error("恢复本地部署备份时缺少当前管理员凭据");
  }
  const db = getDatabase();
  const previousAdmins = db.prepare(`
    SELECT id FROM users WHERE is_gateway_admin = 1 AND id <> ?
  `).all(user.id) as Array<{ id: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET is_gateway_admin = 0, updated_at = CURRENT_TIMESTAMP WHERE is_gateway_admin <> 0").run();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES (?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        is_gateway_admin = 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(user.id, user.displayName);
    const identitySubject = localCredential?.username || user.id;
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id
    `).run(createId("identity"), user.id, user.provider, identitySubject);
    let disabledLocalAccountCount = 0;
    if (localCredential) {
      disabledLocalAccountCount = Number(db.prepare(`
        UPDATE local_accounts SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE disabled_at IS NULL AND user_id <> ?
      `).run(user.id).changes);
      db.prepare("DELETE FROM local_accounts WHERE user_id = ? OR username = ?")
        .run(user.id, localCredential.username);
      db.prepare(`
        INSERT INTO local_accounts (id, user_id, username, password_hash, password_salt)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        createId("account"),
        user.id,
        localCredential.username,
        localCredential.passwordHash,
        localCredential.passwordSalt
      );
    }
    const permissionResult = db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      SELECT id, ?, 'manager', ? FROM health_members WHERE deleted_at IS NULL
      ON CONFLICT(member_id, user_id) DO UPDATE SET
        permission = 'manager',
        granted_by = excluded.granted_by,
        granted_at = CURRENT_TIMESTAMP
    `).run(user.id, user.id);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'backup.identity_rebind', 'user', ?, ?)
    `).run(createId("audit"), user.id, user.id, JSON.stringify({
      previousAdminCount: previousAdmins.length,
      memberPermissionCount: Number(permissionResult.changes),
      disabledLocalAccountCount
    }));
    db.exec("COMMIT");
    return {
      userId: user.id,
      previousAdminCount: previousAdmins.length,
      memberPermissionCount: Number(permissionResult.changes),
      disabledLocalAccountCount
    };
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
}

export const rebindRestoredGatewayAdministrator = rebindRestoredAdministrator;
