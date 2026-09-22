import type { DatabaseSync } from "node:sqlite";

// Unnumbered draft: released migrations remain immutable.
export const memberSharingSchemaSql = `
CREATE TABLE IF NOT EXISTS account_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 self_member_id TEXT REFERENCES health_members(id) ON DELETE SET NULL,
 self_profile_choice TEXT NOT NULL DEFAULT 'undecided' CHECK(self_profile_choice IN ('undecided','created','skipped','pending')),
 default_member_id TEXT REFERENCES health_members(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS member_user_preferences (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
 hidden_at TEXT,
 PRIMARY KEY(user_id, member_id)
);
CREATE TABLE IF NOT EXISTS identity_recovery_pending (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 source_json TEXT NOT NULL,
 mapped_to TEXT REFERENCES users(id),
 mapped_at TEXT
);
CREATE TABLE IF NOT EXISTS member_permission_versions (
 member_id TEXT PRIMARY KEY REFERENCES health_members(id) ON DELETE CASCADE,
 version INTEGER NOT NULL DEFAULT 0
);
`;

export function ensureMemberSharingDraft(db: DatabaseSync) {
 const columns = db.prepare('PRAGMA table_info(member_permissions)').all() as Array<{name: string}>;
 const first = !columns.some(c => c.name === 'can_manage_sharing');
 db.exec('SAVEPOINT member_sharing_draft');
 try {
  if (first) db.exec("ALTER TABLE member_permissions ADD COLUMN can_manage_sharing INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_sharing IN (0,1) AND (can_manage_sharing = 0 OR permission = 'manager'))");
  db.exec(memberSharingSchemaSql);
  if (first) {
   db.exec(`UPDATE member_permissions SET can_manage_sharing = 1
    WHERE permission = 'manager' AND EXISTS (SELECT 1 FROM health_members m WHERE m.id = member_id AND m.created_by = user_id AND m.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = member_permissions.user_id)
    AND NOT EXISTS (SELECT 1 FROM local_accounts a WHERE a.user_id = member_permissions.user_id AND a.disabled_at IS NOT NULL);
    INSERT OR IGNORE INTO account_preferences(user_id,self_member_id,self_profile_choice)
    SELECT u.id, CASE WHEN COUNT(m.id)=1 THEN MIN(m.id) END,
      CASE WHEN COUNT(m.id)=1 THEN 'created' WHEN COUNT(m.id)>1 THEN 'pending' ELSE 'skipped' END
    FROM users u LEFT JOIN health_members m ON m.created_by=u.id AND m.relationship='self' AND m.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM member_permissions p WHERE p.member_id=m.id AND p.user_id=u.id)
    GROUP BY u.id;`);
  }
  db.exec('RELEASE member_sharing_draft');
 } catch (error) { db.exec('ROLLBACK TO member_sharing_draft; RELEASE member_sharing_draft'); throw error; }
}
