import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import { bootstrapLocalAdministrator, createLocalAccount } from '../services/auth.service';
import { createMember, assertMemberAccess, assertMemberShare, setMemberPermission } from '../services/member.service';
import { getAccountPreferences, setMemberHidden, updateAccountPreferences } from '../services/member-preferences.service';
import { createFullBackup, preflightRestore, preflightStoredBackup, restoreBackup, restoreUploadedBackup, listMembers, getReportDetail, listBackups, validateBackup } from '../services/records.service';
import { getRestoreTakeoverRepairStatus, preflightRestoreTakeoverRepair, applyRestoreTakeoverRepair } from '../services/restore-takeover-repair.service';
import { getRequestUser } from '../utils/request-user';
import type { RequestUser } from '../domain/request-user';
import { H3, type H3Event } from 'h3';
import restoreUpload from '../routes/api/backups/restore-upload.post';
import repairStatus from '../routes/api/backups/takeover-repair.get';
import repairUpload from '../routes/api/backups/takeover-repair.post';
import storedPreflight from '../routes/api/backups/[id]/preflight.post';
import errorHandler from '../error-handler';

const status = (code: number) => (error: unknown) => (error as { status: number }).status === code;
function gateway(uid = '2000', admin = true) {
  return getRequestUser({ context: {}, node: { req: { healthAccessMode: 'gateway', headers: { 'x-trim-userid': uid, 'x-trim-username': 'synthetic', 'x-trim-isadmin': String(admin) } } } } as unknown as H3Event);
}
function rewriteArchive(root: string, path: string, name: string, edit: (manifest: any, db: DatabaseSync) => void) {
  const stage = join(root, name); mkdirSync(stage);
  execFileSync('tar', ['-xzf', path, '-C', stage]);
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  const db = new DatabaseSync(join(stage, 'db/health-records.sqlite'));
  try { edit(manifest, db); } finally { db.close(); }
  for (const file of manifest.files || []) {
    const data = readFileSync(join(stage, file.path));
    file.sizeBytes = data.length; file.sha256 = createHash('sha256').update(data).digest('hex');
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest));
  const output = join(root, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', output, '-C', stage, '.']);
  return output;
}
async function fixture(run: (f: { root: string; source: string; target: string; admin: RequestUser; owners: RequestUser[]; ids: string[]; backup: ReturnType<typeof createFullBackup> }) => void | Promise<void>, reverse = false, sameFnos = false) {
  const root = mkdtempSync(join(tmpdir(), 'restore-takeover-'));
  const env = { ...process.env };
  const source = join(root, 'source'), target = join(root, 'target');
  process.env.STORAGE_DIR = source; process.env.AUTH_MODE = reverse ? 'local' : 'fnos'; process.env.DISABLE_JOB_RUNNER = 'true';
  try {
    let owners: RequestUser[];
    if (reverse) {
      bootstrapLocalAdministrator();
      const id = String(getDatabase().prepare('SELECT id FROM users').get()!.id);
      const admin: RequestUser = { id, displayName: 'synthetic', provider: 'local', authenticated: true, isAdmin: true, isGatewayAdmin: true };
      const other = createLocalAccount(admin, { username: 'synthetic-source', displayName: 'synthetic' });
      owners = [admin, { ...admin, id: other.userId, isAdmin: false, isGatewayAdmin: false }];
    } else owners = ['1000', '1001'].map(uid => gateway(uid));
    const ids = [createMember(owners[0], { displayName: 'synthetic-a', createSelf: true }).id,
      createMember(owners[1], { displayName: 'synthetic-b', createSelf: true }).id,
      createMember(owners[1], { displayName: 'synthetic-trash', relationship: 'other' }).id];
    setMemberHidden(owners[0], ids[0], true);
    getDatabase().prepare('UPDATE health_members SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(ids[2]);
    getDatabase().prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES('synthetic-report',?,?,'exam','synthetic','ready')").run(ids[0], owners[0].id);
    mkdirSync(join(source, 'reports'), { recursive: true }); writeFileSync(join(source, 'reports/synthetic.bin'), 'synthetic-original');
    const backup = createFullBackup(owners[0]);
    closeDatabaseForTests(); process.env.STORAGE_DIR = target; process.env.AUTH_MODE = reverse || sameFnos ? 'fnos' : 'local';
    let admin: RequestUser;
    if (reverse || sameFnos) admin = gateway(sameFnos ? '1000' : '2000');
    else {
      bootstrapLocalAdministrator();
      const id = String(getDatabase().prepare('SELECT id FROM users').get()!.id);
      admin = { id, displayName: 'synthetic-admin', provider: 'local', authenticated: true, isAdmin: true, isGatewayAdmin: true };
    }
    await run({ root, source, target, admin, owners, ids, backup });
  } finally { closeDatabaseForTests(); process.env = env; rmSync(root, { recursive: true, force: true }); }
}

for (const stored of [false, true]) test(`fnOS to local ${stored ? 'stored' : 'uploaded'} restore grants all members atomically and supports sharing`, () => fixture(f => {
  const existing = createMember(f.admin, { displayName: 'target-only', createSelf: true });
  const credential = getDatabase().prepare('SELECT password_hash,password_salt,must_change_password FROM local_accounts WHERE user_id=?').get(f.admin.id);
  if (stored) cpSync(join(f.source, 'backups/full'), join(f.target, 'backups/full'), { recursive: true });
  const plan = stored ? preflightStoredBackup(f.admin, f.backup.id) : preflightRestore(f.admin, f.backup.path);
  assert.equal(plan.accessPolicy, 'admin_takeover'); assert.equal(plan.memberCount, 3); assert.equal(plan.sourceMode, 'fnos');
  assert.equal(plan.canChooseTakeover, false); assert.match(plan.warning, /飞牛/);
  const result = stored ? restoreBackup(f.admin, f.backup.id, plan.token) : restoreUploadedBackup(f.admin, f.backup.path, plan.token);
  const login = { ...f.admin, id: result.identityRebind.userId };
  assert.notEqual(login.id, f.admin.id); assert.equal(result.identityRebind.memberPermissionCount, 3);
  assert.equal(result.identityRebind.accessPolicy, 'admin_takeover');
  assert.deepEqual(listMembers(login).map(m => m.id).sort(), f.ids.slice(0, 2).sort());
  assert.equal(getReportDetail(login, 'synthetic-report').id, 'synthetic-report');
  for (const id of f.ids) assert.equal(getDatabase().prepare("SELECT permission,can_manage_sharing FROM member_permissions WHERE member_id=? AND user_id=?").get(id, login.id)!.can_manage_sharing, 1);
  assert.ok(getDatabase().prepare('SELECT deleted_at FROM health_members WHERE id=?').get(f.ids[2])!.deleted_at);
  assert.equal(getDatabase().prepare('SELECT created_by FROM health_members WHERE id=?').get(f.ids[0])!.created_by, f.owners[0].id);
  assert.equal(getDatabase().prepare('SELECT 1 FROM health_members WHERE id=?').get(existing.id), undefined);
  assert.equal(getAccountPreferences(login)?.selfMemberId ?? null, null);
  assert.equal(listMembers(login).find(m => m.id === f.ids[0])!.hidden, 0);
  assert.equal(readFileSync(join(f.target, 'reports/synthetic.bin'), 'utf8'), 'synthetic-original');
  assert.deepEqual(getDatabase().prepare('SELECT password_hash,password_salt,must_change_password FROM local_accounts WHERE user_id=?').get(login.id), credential);
  assert.throws(() => assertMemberAccess(f.owners[0], f.ids[0]), status(403));
  assert.equal(getRestoreTakeoverRepairStatus(login).available, false);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM identity_recovery_pending WHERE mapped_at IS NOT NULL').get()!.n, 0);
  const ordinary = createLocalAccount(login, { username: 'synthetic-local', displayName: 'synthetic-local' });
  const user = { ...login, id: ordinary.userId, isAdmin: false, isGatewayAdmin: false };
  assert.equal(listMembers(user).length, 0);
  const version = Number(getDatabase().prepare('SELECT version FROM member_permission_versions WHERE member_id=?').get(f.ids[0])!.version);
  setMemberPermission(login, f.ids[0], { userId: user.id, permission: 'viewer', version });
  assert.equal(assertMemberAccess(user, f.ids[0]), 'viewer'); assertMemberShare(login, f.ids[0]);
  assert.throws(() => assertMemberAccess(user, f.ids[1]), status(403));
  assert.throws(() => restoreUploadedBackup(login, f.backup.path, plan.token), status(409));
}));

test('legacy requires explicit choice; same instance and known non-fnos sources cannot choose takeover', () => fixture(f => {
  const legacy = rewriteArchive(f.root, f.backup.path, 'legacy', manifest => { delete manifest.identity; });
  assert.equal(preflightRestore(f.admin, legacy).accessPolicy, 'isolate');
  const chosen = preflightRestore(f.admin, legacy, true); assert.equal(chosen.accessPolicy, 'admin_takeover'); assert.equal(chosen.canChooseTakeover, true);
  const local = createFullBackup(f.admin);
  assert.equal(preflightRestore(f.admin, local.path).accessPolicy, 'preserve');
  assert.throws(() => preflightRestore(f.admin, local.path, true), status(400));
  const foreign = rewriteArchive(f.root, local.path, 'foreign-local', manifest => { manifest.identity.id = 'other'; });
  assert.equal(preflightRestore(f.admin, foreign).accessPolicy, 'isolate');
  assert.throws(() => preflightRestore(f.admin, foreign, true), status(400));
  const result = restoreUploadedBackup(f.admin, legacy, chosen.token);
  assert.equal(listMembers({ ...f.admin, id: result.identityRebind.userId }).length, 2);
}));

test('ordinary, unauthenticated, stale administrators and substituted archives cannot take over', () => fixture(f => {
  const plan = preflightRestore(f.admin, f.backup.path);
  assert.throws(() => preflightRestore({ ...f.admin, authenticated: false }, f.backup.path), status(403));
  assert.throws(() => preflightRestore({ ...f.admin, isAdmin: false }, f.backup.path), status(403));
  assert.throws(() => getRestoreTakeoverRepairStatus({ ...f.admin, isAdmin: false }), status(403));
  const other = rewriteArchive(f.root, f.backup.path, 'substituted', manifest => { manifest.createdAt = '2000-01-01'; });
  assert.throws(() => restoreUploadedBackup(f.admin, other, plan.token), status(409));
  const localAccount = getDatabase().prepare('SELECT id FROM local_accounts WHERE user_id=?').get(f.admin.id)!;
  getDatabase().prepare('UPDATE local_accounts SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(localAccount.id);
  assert.throws(() => restoreUploadedBackup(f.admin, f.backup.path, plan.token), status(403));
}));

test('grant failure keeps target data and credentials intact; safety backup remains available', () => fixture(f => {
  const member = createMember(f.admin, { displayName: 'target-only', createSelf: true });
  const failing = rewriteArchive(f.root, f.backup.path, 'grant-failure', (_manifest, db) => {
    db.exec("CREATE TRIGGER reject_takeover BEFORE INSERT ON member_permissions BEGIN SELECT RAISE(ABORT,'synthetic grant failure'); END");
  });
  const before = getDatabase().prepare('SELECT * FROM local_accounts').all();
  const plan = preflightRestore(f.admin, failing);
  assert.throws(() => restoreUploadedBackup(f.admin, failing, plan.token), /synthetic grant failure/);
  assert.equal(assertMemberAccess(f.admin, member.id), 'manager');
  assert.deepEqual(getDatabase().prepare('SELECT * FROM local_accounts').all(), before);
  assert.equal(existsSync(join(f.target, 'reports/synthetic.bin')), false);
  assert.equal(existsSync(join(f.target, 'restore-maintenance.json')), false);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='backup.create' AND detail_json LIKE '%pre_restore%'").get()!.n, 1);
}));

function historical(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const legacy = rewriteArchive(f.root, f.backup.path, 'historical', manifest => { delete manifest.identity; });
  const plan = preflightRestore(f.admin, legacy);
  const result = restoreUploadedBackup(f.admin, legacy, plan.token);
  return { ...f.admin, id: result.identityRebind.userId };
}

test('historical repair checks original archive, excludes mapped and already managed members and completes once', () => fixture(f => {
  const login = historical(f);
  const local = createLocalAccount(login, { username: 'assigned', displayName: 'synthetic' });
  const db = getDatabase();
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by) VALUES(?,?,'manager',1,?)").run(f.ids[1], local.userId, login.id);
  // A newer, unrelated member with a pending creator must not be pulled into the repair.
  db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES('not-in-backup','synthetic',?)").run(f.owners[0].id);
  db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by) VALUES('not-in-backup',?,'manager',1,?)").run(f.owners[0].id, f.owners[0].id);
  assert.equal(getRestoreTakeoverRepairStatus(login).available, true);
  const wrong = rewriteArchive(f.root, f.backup.path, 'wrong', manifest => { manifest.id = 'backup_wrong'; });
  assert.throws(() => preflightRestoreTakeoverRepair(login, wrong), status(409));
  const plan = preflightRestoreTakeoverRepair(login, f.backup.path); assert.equal(plan.memberCount, 2);
  const result = applyRestoreTakeoverRepair(login, f.backup.path, plan.token); assert.equal(result.memberCount, 2);
  assert.equal(assertMemberAccess(login, f.ids[0]), 'manager');
  assert.throws(() => assertMemberAccess(login, f.ids[1]), status(403));
  assert.throws(() => assertMemberAccess(login, 'not-in-backup'), status(403));
  assert.equal(getRestoreTakeoverRepairStatus(login).available, false);
  assert.throws(() => applyRestoreTakeoverRepair(login, f.backup.path, plan.token), status(409));
  assert.throws(() => preflightRestoreTakeoverRepair(login, f.backup.path), status(409));
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM identity_recovery_pending WHERE mapped_at IS NOT NULL').get()!.n, 0);
}));

test('historical repair rejects changed permissions, mapped identities, different actor, deployment and missing evidence', () => fixture(f => {
  const login = historical(f);
  const db = getDatabase();
  const plan = preflightRestoreTakeoverRepair(login, f.backup.path);
  db.prepare('UPDATE identity_recovery_pending SET mapped_at=CURRENT_TIMESTAMP,mapped_to=? WHERE user_id=?').run(login.id, f.owners[1].id);
  assert.throws(() => applyRestoreTakeoverRepair(login, f.backup.path, plan.token), status(409));
  const next = preflightRestoreTakeoverRepair(login, f.backup.path); assert.equal(next.memberCount, 1);
  writeFileSync(join(f.target, 'deployment-identity.json'), JSON.stringify({ id: 'different-deployment' }));
  assert.throws(() => applyRestoreTakeoverRepair(login, f.backup.path, next.token), status(409));
  db.exec("DELETE FROM audit_logs WHERE action='backup.identity_restore'");
  assert.equal(getRestoreTakeoverRepairStatus(login).available, false);
  assert.throws(() => preflightRestoreTakeoverRepair(login, f.backup.path), status(409));
}));

test('historical grant failure rolls back all permissions and can retry without repeating restore', () => fixture(f => {
  const login = historical(f); const db = getDatabase();
  db.prepare("CREATE TRIGGER reject_repair BEFORE INSERT ON member_permissions WHEN NEW.member_id='" + f.ids[2] + "' BEGIN SELECT RAISE(ABORT,'synthetic repair failure'); END").run();
  const before = db.prepare('SELECT * FROM member_permissions ORDER BY member_id,user_id').all();
  const versions = db.prepare('SELECT * FROM member_permission_versions ORDER BY member_id').all();
  const plan = preflightRestoreTakeoverRepair(login, f.backup.path);
  assert.throws(() => applyRestoreTakeoverRepair(login, f.backup.path, plan.token), /synthetic repair failure/);
  assert.deepEqual(db.prepare('SELECT * FROM member_permissions ORDER BY member_id,user_id').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM member_permission_versions ORDER BY member_id').all(), versions);
  assert.equal(getRestoreTakeoverRepairStatus(login).available, true);
  db.exec('DROP TRIGGER reject_repair');
  assert.equal(applyRestoreTakeoverRepair(login, f.backup.path, plan.token).memberCount, 3);
}));

test('failure after database switching restores target files, grants and administrator credentials', () => fixture(f => {
  const member = createMember(f.admin, { displayName: 'target-only', createSelf: true });
  mkdirSync(join(f.target, 'reports'), { recursive: true }); writeFileSync(join(f.target, 'reports/target.bin'), 'target-original');
  const failing = rewriteArchive(f.root, f.backup.path, 'switch-failure', (_manifest, db) => {
    db.exec("CREATE TRIGGER reject_restore_audit BEFORE INSERT ON audit_logs WHEN NEW.action='backup.restore' BEGIN SELECT RAISE(ABORT,'synthetic switch failure'); END");
  });
  const before = getDatabase().prepare('SELECT * FROM local_accounts').all();
  const plan = preflightRestore(f.admin, failing);
  assert.throws(() => restoreUploadedBackup(f.admin, failing, plan.token), /synthetic switch failure/);
  assert.equal(assertMemberAccess(f.admin, member.id), 'manager');
  assert.deepEqual(getDatabase().prepare('SELECT * FROM local_accounts').all(), before);
  assert.equal(readFileSync(join(f.target, 'reports/target.bin'), 'utf8'), 'target-original');
  assert.equal(existsSync(join(f.target, 'reports/synthetic.bin')), false);
  assert.equal(existsSync(join(f.target, 'restore-maintenance.json')), false);
}));

test('expired restore and repair tokens and another administrator cannot confirm', () => fixture(f => {
  const plan = preflightRestore(f.admin, f.backup.path);
  const now = Date.now;
  try {
    Date.now = () => now() + 16 * 60 * 1000;
    assert.throws(() => restoreUploadedBackup(f.admin, f.backup.path, plan.token), status(409));
  } finally { Date.now = now; }
  const login = historical(f);
  const other = createLocalAccount(login, { username: 'other-admin', displayName: 'synthetic' });
  getDatabase().prepare('UPDATE users SET is_gateway_admin=1 WHERE id=?').run(other.userId);
  const repair = preflightRestoreTakeoverRepair(login, f.backup.path);
  assert.throws(() => applyRestoreTakeoverRepair({ ...login, id: other.userId }, f.backup.path, repair.token), status(409));
  const substituted = rewriteArchive(f.root, f.backup.path, 'repair-substitution', manifest => { manifest.createdAt = '2000-01-01'; });
  assert.throws(() => applyRestoreTakeoverRepair(login, substituted, repair.token), status(409));
  try {
    Date.now = () => now() + 16 * 60 * 1000;
    assert.throws(() => applyRestoreTakeoverRepair(login, f.backup.path, repair.token), status(409));
  } finally { Date.now = now; }
}));

for (const stored of [false, true]) test(`local to fnOS ${stored ? 'stored' : 'uploaded'} restore retains target gateway login and grants all restored archives`, () => fixture(f => {
  const existing = createMember(f.admin, { displayName: 'target-only', createSelf: true });
  const ordinaryBefore = gateway('2001', false);
  if (stored) cpSync(join(f.source, 'backups/full'), join(f.target, 'backups/full'), { recursive: true });
  const plan = stored ? preflightStoredBackup(f.admin, f.backup.id) : preflightRestore(f.admin, f.backup.path);
  assert.equal(plan.accessPolicy, 'admin_takeover'); assert.equal(plan.sourceMode, 'local'); assert.equal(plan.targetMode, 'fnos');
  assert.equal(plan.canChooseTakeover, false); assert.match(plan.warning, /已有档案设为本人/); assert.doesNotMatch(plan.warning, /分配给本地账号/);
  const result = stored ? restoreBackup(f.admin, f.backup.id, plan.token) : restoreUploadedBackup(f.admin, f.backup.path, plan.token);
  const login = gateway();
  assert.equal(login.id, result.identityRebind.userId); assert.notEqual(login.id, f.admin.id);
  assert.equal(result.identityRebind.memberPermissionCount, 3);
  assert.deepEqual(listMembers(login).map(m => m.id).sort(), f.ids.slice(0, 2).sort());
  assert.equal(getReportDetail(login, 'synthetic-report').id, 'synthetic-report');
  assert.equal(readFileSync(join(f.target, 'reports/synthetic.bin'), 'utf8'), 'synthetic-original');
  const db = getDatabase();
  assert.equal(db.prepare('SELECT 1 FROM health_members WHERE id=?').get(existing.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_accounts WHERE disabled_at IS NULL').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, f.owners.length + 1, 'only target administrator identity is re-established');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identity_recovery_pending WHERE mapped_at IS NOT NULL').get()!.n, 0);
  assert.equal(getAccountPreferences(login)?.selfMemberId ?? null, null);
  assert.equal(listMembers(login).find(m => m.id === f.ids[0])!.hidden, 0);
  assert.equal(db.prepare('SELECT created_by FROM health_members WHERE id=?').get(f.ids[0])!.created_by, f.owners[0].id);
  assert.ok(db.prepare('SELECT deleted_at FROM health_members WHERE id=?').get(f.ids[2])!.deleted_at);
  for (const id of f.ids.slice(0, 2)) assertMemberShare(login, id);
  assert.equal(db.prepare("SELECT can_manage_sharing FROM member_permissions WHERE member_id=? AND user_id=?").get(f.ids[2], login.id)!.can_manage_sharing, 1);
  assert.throws(() => assertMemberAccess(f.owners[0], f.ids[0]), status(403));
  assert.throws(() => assertMemberAccess(ordinaryBefore, f.ids[0]), status(403));
  updateAccountPreferences(login, { selfMemberId: f.ids[0], defaultMemberId: f.ids[0] });
  assert.equal(getAccountPreferences(login)!.selfMemberId, f.ids[0]);
  const ordinary = gateway('2001', false); assert.equal(listMembers(ordinary).length, 0);
  const version = Number(db.prepare('SELECT version FROM member_permission_versions WHERE member_id=?').get(f.ids[0])!.version);
  setMemberPermission(login, f.ids[0], { userId: ordinary.id, permission: 'viewer', version });
  assert.equal(assertMemberAccess(ordinary, f.ids[0]), 'viewer');
  assert.throws(() => assertMemberAccess(ordinary, f.ids[1]), status(403));
  assert.equal(getRestoreTakeoverRepairStatus(login).available, false);
  assert.throws(() => restoreUploadedBackup(login, f.backup.path, plan.token), status(409));
}, true));

test('fnOS legacy and foreign NAS backups require explicit choice; same-instance restore cannot take over', () => fixture(f => {
  const legacy = rewriteArchive(f.root, f.backup.path, 'unknown-on-fnos', manifest => { delete manifest.identity; });
  assert.equal(preflightRestore(f.admin, legacy).accessPolicy, 'isolate');
  const chosen = preflightRestore(f.admin, legacy, true);
  assert.equal(chosen.canChooseTakeover, true); assert.equal(chosen.accessPolicy, 'admin_takeover');
  assert.throws(() => preflightRestore(f.admin, f.backup.path, true), status(400));
  const own = createFullBackup(f.admin);
  assert.equal(preflightRestore(f.admin, own.path).accessPolicy, 'preserve');
  const foreign = rewriteArchive(f.root, own.path, 'foreign-fnos', manifest => { manifest.identity.id = 'other'; });
  assert.equal(preflightRestore(f.admin, foreign).accessPolicy, 'isolate');
  assert.equal(preflightRestore(f.admin, foreign).canChooseTakeover, true);
  assert.equal(preflightRestore(f.admin, foreign, true).accessPolicy, 'admin_takeover');
  assert.throws(() => preflightRestore(f.admin, own.path, true), status(400));
  restoreUploadedBackup(f.admin, legacy, chosen.token);
  assert.equal(listMembers(gateway()).length, 2);
}, true));

for (const stored of [false, true]) for (const takeover of [false, true]) {
  test(`fnOS to another NAS ${stored ? 'stored' : 'uploaded'} restore ${takeover ? 'explicitly takes over' : 'remains isolated by default'}`, () => fixture(f => {
    const targetMember = createMember(f.admin, { displayName: 'synthetic-target', relationship: 'other' });
    if (stored) cpSync(join(f.source, 'backups/full'), join(f.target, 'backups/full'), { recursive: true });
    const preflight = (chosen = false) => stored
      ? preflightStoredBackup(f.admin, f.backup.id, chosen)
      : preflightRestore(f.admin, f.backup.path, chosen);
    const initial = preflight();
    assert.equal(initial.strategy, 'cross');
    assert.equal(initial.sourceMode, 'fnos'); assert.equal(initial.targetMode, 'fnos');
    assert.equal(initial.accessPolicy, 'isolate'); assert.equal(initial.canChooseTakeover, true);
    assert.match(initial.warning, /勾选/);
    assert.notEqual(f.admin.id, f.owners[0].id, 'equal gateway UIDs on different NAS devices do not prove identity');
    assert.equal(assertMemberAccess(f.admin, targetMember.id), 'manager', 'preflight must not replace target data');
    assert.throws(() => preflightRestore({ ...f.admin, isAdmin: false, isGatewayAdmin: false }, f.backup.path, true), status(403));
    const plan = takeover ? preflight(true) : initial;
    const result = stored ? restoreBackup(f.admin, f.backup.id, plan.token) : restoreUploadedBackup(f.admin, f.backup.path, plan.token);
    const login = gateway('1000');
    assert.equal(login.id, result.identityRebind.userId);
    assert.equal(result.identityRebind.accessPolicy, takeover ? 'admin_takeover' : 'isolate');
    assert.equal(result.identityRebind.memberPermissionCount, takeover ? 3 : 0);
    assert.deepEqual(listMembers(login).map(m => m.id).sort(), takeover ? f.ids.slice(0, 2).sort() : []);
    assert.equal(getDatabase().prepare('SELECT 1 FROM health_members WHERE id=?').get(targetMember.id), undefined);
    assert.equal(getDatabase().prepare('SELECT created_by FROM health_members WHERE id=?').get(f.ids[0])!.created_by, f.owners[0].id);
    assert.ok(getDatabase().prepare('SELECT deleted_at FROM health_members WHERE id=?').get(f.ids[2])!.deleted_at);
    assert.equal(readFileSync(join(f.target, 'reports/synthetic.bin'), 'utf8'), 'synthetic-original');
    assert.equal(getAccountPreferences(login)?.selfMemberId ?? null, null);
    assert.throws(() => assertMemberAccess(f.owners[0], f.ids[0]), status(403));
    const ordinary = gateway('1001', false);
    assert.equal(listMembers(ordinary).length, 0, 'a matching old NAS UID receives no access');
    if (takeover) {
      assert.equal(getReportDetail(login, 'synthetic-report').id, 'synthetic-report');
      for (const id of f.ids.slice(0, 2)) assertMemberShare(login, id);
      assert.equal(getDatabase().prepare('SELECT can_manage_sharing FROM member_permissions WHERE member_id=? AND user_id=?').get(f.ids[2], login.id)!.can_manage_sharing, 1);
      const version = Number(getDatabase().prepare('SELECT version FROM member_permission_versions WHERE member_id=?').get(f.ids[0])!.version);
      setMemberPermission(login, f.ids[0], { userId: ordinary.id, permission: 'viewer', version });
      assert.equal(assertMemberAccess(ordinary, f.ids[0]), 'viewer');
      assert.throws(() => assertMemberAccess(ordinary, f.ids[1]), status(403));
    }
    assert.throws(() => restoreUploadedBackup(login, f.backup.path, plan.token), status(409));
  }, false, true));
}

for (const switched of [false, true]) test(`cross-NAS explicit takeover rolls back ${switched ? 'after switching' : 'before switching'}`, () => fixture(f => {
  const existing = createMember(f.admin, { displayName: 'synthetic-target', createSelf: true });
  const failing = rewriteArchive(f.root, f.backup.path, 'nas-grant-failure', (_manifest, db) => {
    db.exec(switched ? "CREATE TRIGGER reject_restore_audit BEFORE INSERT ON audit_logs WHEN NEW.action='backup.restore' BEGIN SELECT RAISE(ABORT,'synthetic NAS restore failure'); END"
      : "CREATE TRIGGER reject_takeover BEFORE INSERT ON member_permissions BEGIN SELECT RAISE(ABORT,'synthetic NAS grant failure'); END");
  });
  const plan = preflightRestore(f.admin, failing, true);
  assert.throws(() => restoreUploadedBackup(f.admin, failing, plan.token), /synthetic NAS/);
  assert.equal(gateway('1000').id, f.admin.id);
  assert.equal(assertMemberAccess(f.admin, existing.id), 'manager');
  assert.equal(existsSync(join(f.target, 'reports/synthetic.bin')), false);
  assert.equal(existsSync(join(f.target, 'restore-maintenance.json')), false);
  const safety = listBackups(f.admin).filter(backup => backup.reason === 'pre_restore');
  assert.equal(safety.length, 1);
  assert.equal(validateBackup(f.admin, safety[0].id).valid, true);
}, false, true));

test('fnOS restore rejects stale roles, pending identities, wrong providers and changed gateway subjects', () => fixture(f => {
  assert.throws(() => preflightRestore({ ...f.admin, authenticated: false }, f.backup.path), status(403));
  assert.throws(() => preflightRestore({ ...f.admin, provider: 'local' }, f.backup.path), status(403));
  const plan = preflightRestore(f.admin, f.backup.path);
  const db = getDatabase();
  db.prepare('UPDATE users SET is_gateway_admin=0 WHERE id=?').run(f.admin.id);
  assert.throws(() => restoreUploadedBackup(f.admin, f.backup.path, plan.token), status(403));
  db.prepare('UPDATE users SET is_gateway_admin=1 WHERE id=?').run(f.admin.id);
  db.prepare("UPDATE user_identities SET subject='unscoped' WHERE user_id=?").run(f.admin.id);
  assert.throws(() => preflightRestore(f.admin, f.backup.path), status(403));
  gateway(); // New validated target identity cannot execute another actor's plan.
  assert.throws(() => restoreUploadedBackup(gateway(), f.backup.path, plan.token), status(409));
  const admin = gateway();
  db.prepare("INSERT INTO identity_recovery_pending(user_id,source_json) VALUES(?,'{}')").run(admin.id);
  assert.throws(() => preflightRestore(admin, f.backup.path), status(403));
}, true));

for (const switched of [false, true]) test(`local to fnOS rollback ${switched ? 'after switching' : 'before switching'} preserves target files and gateway identity`, () => fixture(f => {
  const member = createMember(f.admin, { displayName: 'target-only', createSelf: true });
  mkdirSync(join(f.target, 'reports'), { recursive: true }); writeFileSync(join(f.target, 'reports/target.bin'), 'target-original');
  const failing = rewriteArchive(f.root, f.backup.path, 'failure', (_manifest, db) => {
    db.exec(switched ? "CREATE TRIGGER reject_restore_audit BEFORE INSERT ON audit_logs WHEN NEW.action='backup.restore' BEGIN SELECT RAISE(ABORT,'synthetic switch failure'); END"
      : "CREATE TRIGGER reject_takeover BEFORE INSERT ON member_permissions BEGIN SELECT RAISE(ABORT,'synthetic grant failure'); END");
  });
  const plan = preflightRestore(f.admin, failing);
  assert.throws(() => restoreUploadedBackup(f.admin, failing, plan.token), /synthetic (switch|grant) failure/);
  assert.equal(gateway().id, f.admin.id);
  assert.equal(assertMemberAccess(gateway(), member.id), 'manager');
  assert.equal(readFileSync(join(f.target, 'reports/target.bin'), 'utf8'), 'target-original');
  assert.equal(existsSync(join(f.target, 'reports/synthetic.bin')), false);
  assert.equal(existsSync(join(f.target, 'restore-maintenance.json')), false);
}, true));

test('historical Docker to fnOS repair verifies source and grants only unmanaged archives once', () => fixture(f => {
  const legacy = rewriteArchive(f.root, f.backup.path, 'historical-local', manifest => { delete manifest.identity; });
  const plan = preflightRestore(f.admin, legacy);
  restoreUploadedBackup(f.admin, legacy, plan.token);
  const admin = gateway();
  const ordinary = gateway('2001', false);
  assert.throws(() => getRestoreTakeoverRepairStatus(ordinary), status(403));
  assert.equal(getRestoreTakeoverRepairStatus(admin).available, true);
  // Explicitly managed/mapped archives remain outside repair scope.
  getDatabase().prepare("INSERT INTO member_permissions(member_id,user_id,permission,can_manage_sharing,granted_by) VALUES(?,?,'manager',1,?)").run(f.ids[1], ordinary.id, admin.id);
  const wrong = rewriteArchive(f.root, f.backup.path, 'wrong-source-mode', manifest => { manifest.identity.authMode = 'fnos'; });
  assert.throws(() => preflightRestoreTakeoverRepair(admin, wrong), status(409));
  const repair = preflightRestoreTakeoverRepair(admin, f.backup.path); assert.equal(repair.memberCount, 2);
  getDatabase().exec("CREATE TRIGGER reject_repair BEFORE INSERT ON member_permissions WHEN NEW.member_id='" + f.ids[2] + "' BEGIN SELECT RAISE(ABORT,'synthetic repair failure'); END");
  const before = getDatabase().prepare('SELECT * FROM member_permissions ORDER BY member_id,user_id').all();
  assert.throws(() => applyRestoreTakeoverRepair(admin, f.backup.path, repair.token), /synthetic repair failure/);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM member_permissions ORDER BY member_id,user_id').all(), before);
  getDatabase().exec('DROP TRIGGER reject_repair');
  assert.equal(applyRestoreTakeoverRepair(admin, f.backup.path, repair.token).memberCount, 2);
  assert.equal(assertMemberAccess(admin, f.ids[0]), 'manager');
  assert.throws(() => assertMemberAccess(admin, f.ids[1]), status(403));
  assert.equal(getRestoreTakeoverRepairStatus(admin).available, false);
  assert.throws(() => applyRestoreTakeoverRepair(admin, f.backup.path, repair.token), status(409));
}, true));

for (const reverse of [false, true]) test(`HTTP multipart ${reverse ? 'local to fnOS' : 'fnOS to local'} binds policy to token and historical repair remains administrator-only`, () => fixture(async f => {
  const app = new H3({ onError: errorHandler });
  let actor = f.admin;
  app.use(event => { event.context.requestUser = actor; });
  app.post('/api/backups/restore-upload', restoreUpload);
  app.get('/api/backups/takeover-repair', repairStatus);
  app.post('/api/backups/takeover-repair', repairUpload);
  app.post('/api/backups/:id/preflight', storedPreflight);
  const legacy = rewriteArchive(f.root, f.backup.path, 'http-legacy', manifest => { delete manifest.identity; });
  function body(path: string, fields: Record<string, string> = {}) {
    const form = new FormData(); form.append('backup', new Blob([readFileSync(path)]), 'synthetic.tar.gz');
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return form;
  }
  const post = (route: string, form: FormData) => app.request(`http://localhost/api/backups/${route}`, { method: 'POST', body: form });
  const preview = await post('restore-upload', body(legacy)); assert.equal(preview.status, 200);
  const plan = (await preview.json()).data; assert.equal(plan.accessPolicy, 'isolate');
  // A final request cannot change the policy that was bound during preflight.
  const response = await post('restore-upload', body(legacy, { token: plan.token, takeover: 'true' }));
  assert.equal(response.status, 200); const result = (await response.json()).data;
  actor = { ...f.admin, id: result.identityRebind.userId };
  assert.equal(listMembers(actor).length, 0); assert.equal(result.identityRebind.accessPolicy, 'isolate');
  const before = await app.request('http://localhost/api/backups/takeover-repair');
  assert.deepEqual((await before.json()).data, { available: true });
  const checked = await post('takeover-repair', body(f.backup.path)); assert.equal(checked.status, 200);
  const repair = (await checked.json()).data;
  assert.deepEqual(Object.keys(repair).sort(), ['memberCount', 'token', 'warning']);
  const admin = actor; actor = { ...actor, isAdmin: false, isGatewayAdmin: false };
  assert.equal((await app.request('http://localhost/api/backups/takeover-repair')).status, 403);
  assert.equal((await post('takeover-repair', body(f.backup.path, { token: repair.token }))).status, 403);
  actor = admin;
  const done = await post('takeover-repair', body(f.backup.path, { token: repair.token }));
  assert.equal(done.status, 200); assert.equal((await done.json()).data.memberCount, 3);
  assert.deepEqual((await (await app.request('http://localhost/api/backups/takeover-repair')).json()).data, { available: false });
  assert.equal((await post('takeover-repair', body(f.backup.path, { token: repair.token }))).status, 409);
  const invalid = await app.request(`http://localhost/api/backups/${f.backup.id}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takeover: 'true' }) });
  assert.equal(invalid.status, 400);
}, reverse));
