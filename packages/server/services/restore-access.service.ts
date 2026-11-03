import { createError } from 'h3';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database/client';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { getAppConfig } from '../utils/runtime-config';
import { getDeploymentIdentity } from '../utils/deployment-identity';

export type RestoreAccessPolicy = 'preserve' | 'isolate' | 'admin_takeover';

export function assertRestoreAdministrator(user: RequestUser) {
  if (!user.authenticated || !isAdministrator(user)) throw createError({ statusCode: 403, statusMessage: '仅管理员可恢复或接管档案' });
  if (getAppConfig().authMode === 'local') {
    if (user.provider !== 'local' || !getDatabase().prepare(`SELECT 1 FROM users u
      JOIN local_accounts a ON a.user_id=u.id AND a.disabled_at IS NULL
      JOIN user_identities i ON i.user_id=u.id AND i.provider='local'
      WHERE u.id=? AND u.is_gateway_admin=1
      AND NOT EXISTS(SELECT 1 FROM identity_recovery_pending p WHERE p.user_id=u.id)`).get(user.id)) {
      throw createError({ statusCode: 403, statusMessage: '当前管理员账号已失效，请重新登录' });
    }
  } else if (getAppConfig().authMode === 'fnos') {
    const identity = getDatabase().prepare(`SELECT i.subject FROM users u
      JOIN user_identities i ON i.user_id=u.id AND i.provider='fnos_gateway'
      WHERE u.id=? AND u.is_gateway_admin=1
      AND NOT EXISTS(SELECT 1 FROM identity_recovery_pending p WHERE p.user_id=u.id)`).get(user.id) as { subject: string } | undefined;
    const prefix = `${getDeploymentIdentity().identityDomain}:`;
    if (user.provider !== 'fnos_gateway' || !identity?.subject.startsWith(prefix) || identity.subject.length <= prefix.length) {
      throw createError({ statusCode: 403, statusMessage: '当前飞牛管理员身份已失效，请重新进入应用' });
    }
  }
}

export function restoreAccessPolicy(sourceMode: string | undefined, strategy: 'same' | 'cross', takeover: boolean) {
  const targetMode = getAppConfig().authMode;
  const supportedTarget = targetMode === 'local' || targetMode === 'fnos';
  const crossAuthentication = (targetMode === 'local' && sourceMode === 'fnos') || (targetMode === 'fnos' && sourceMode === 'local');
  // A different NAS has a different identity domain, even when gateway UIDs match.
  // Keep isolation as the default and require a fresh, explicit takeover preflight.
  const canChooseTakeover = supportedTarget && strategy === 'cross'
    && (sourceMode === undefined || (sourceMode === 'fnos' && targetMode === 'fnos'));
  if (takeover && !canChooseTakeover) throw createError({ statusCode: 400, statusMessage: '此备份不支持手动接管选项，请重新预检' });
  const accessPolicy: RestoreAccessPolicy = strategy === 'same' ? 'preserve'
    : supportedTarget && (crossAuthentication || (canChooseTakeover && takeover)) ? 'admin_takeover' : 'isolate';
  return { accessPolicy, canChooseTakeover };
}

// Caller owns the transaction. Never changes creators, deleted state, identities or preferences.
export function grantRestoredMembers(db: DatabaseSync, administratorId: string, memberIds: string[]) {
  const grant = db.prepare(`INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by)
    VALUES(?,?,'manager',1,?) ON CONFLICT(member_id,user_id) DO UPDATE SET
    permission='manager',can_manage_sharing=1,granted_by=excluded.granted_by,granted_at=CURRENT_TIMESTAMP`);
  const version = db.prepare(`INSERT INTO member_permission_versions(member_id,version) VALUES(?,1)
    ON CONFLICT(member_id) DO UPDATE SET version=version+1`);
  for (const id of memberIds) {
    grant.run(id, administratorId, administratorId);
    version.run(id);
  }
  for (const id of memberIds) {
    if (!db.prepare("SELECT 1 FROM member_permissions WHERE member_id=? AND user_id=? AND permission='manager' AND can_manage_sharing=1").get(id, administratorId)) {
      throw new Error('恢复档案授权校验失败');
    }
  }
  return memberIds.length;
}

export function memberIdsInBackup(db: DatabaseSync) {
  return (db.prepare('SELECT id FROM health_members ORDER BY id').all() as Array<{ id: string }>).map(row => row.id);
}
