import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createHealthEvent, getHealthEvent } from '../services/health-event.service';
import { createHealthEpisode } from '../services/health-episode.service';
import { createProcessSymptomUpdate } from '../services/symptom-episode.service';
import { createReminder, listReminders, updateReminderStatus, mergeDuplicateReport } from '../services/records.service';
import { createMedicationCourse, createMedicationIntake } from '../services/medication.service';
import { exportMemberHealthWorkflow, validateHealthWorkflowDatabase } from '../services/health-workflow-integrity.service';
import { dateInput } from '../services/health-event-input';

const manager: RequestUser = { id: 'manager', displayName: '合成管理', provider: 'development', authenticated: true, isGatewayAdmin: true };
const viewer: RequestUser = { ...manager, id: 'viewer', isGatewayAdmin: false };
const outsider: RequestUser = { ...manager, id: 'outsider', isGatewayAdmin: false };
function status(fn: () => unknown, code: number) { assert.throws(fn, (error: unknown) => (error as { statusCode: number }).statusCode === code); }
function fixture(run: (db: DatabaseSync) => void) {
  const previous = process.env.STORAGE_DIR;
  const directory = mkdtempSync(join(tmpdir(), 'health-workflow-')); process.env.STORAGE_DIR = directory;
  try {
    const db = getDatabase();
    for (const user of [manager, viewer, outsider]) db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(user.id, user.displayName);
    for (const id of ['member', 'other']) {
      db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES(?,'合成成员','manager')").run(id);
      db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'manager','manager','manager')").run(id);
    }
    db.exec("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','viewer','viewer','manager')");
    for (const id of ['report', 'target']) db.prepare(`INSERT INTO reports(id,member_id,created_by,title,report_type,status,examined_at)
      VALUES(?,'member','manager','合成资料','outpatient','ready','2025-01-02')`).run(id);
    run(db);
  } finally { closeDatabaseForTests(); if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous; rmSync(directory, { recursive: true, force: true }); }
}

// Savepoints are needed because upload archiving reuses the independently transactional event service.
test('nested service transactions roll back atomically and recover after a caught inner failure', () => fixture(db => {
  assert.throws(() => runInTransaction(db, () => {
    createHealthEvent(manager, { memberId: 'member', eventType: 'outpatient' });
    throw new Error('synthetic outer failure');
  }), /outer failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_events').get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='event.create'").get()!.n, 0);
  runInTransaction(db, () => {
    const before = createHealthEvent(manager, { memberId: 'member', eventType: 'outpatient' });
    assert.throws(() => runInTransaction(db, () => {
      db.prepare('DELETE FROM health_events WHERE id=?').run(before.id);
      throw new Error('synthetic inner failure');
    }), /inner failure/);
    assert.ok(getHealthEvent(manager, before.id));
    createHealthEvent(manager, { memberId: 'member', eventType: 'follow_up' });
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_events').get()!.n, 2);
}));

test('duplicate report merge carries event, reminder and confirmed medication references atomically', () => fixture(db => {
  const event = createHealthEvent(manager, { memberId: 'member', eventType: 'outpatient', reportIds: ['report', 'target'] });
  db.exec(`INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256)
    VALUES('page','report',1,'synthetic.png','reports/synthetic.png','image/png',1,'synthetic');
    INSERT INTO report_medications(id,report_id,medication_name,dose) VALUES('prescription','report','合成药品','1');
    INSERT INTO health_upload_items(report_id,state,event_id) SELECT 'report','archived',id FROM health_events;
    INSERT INTO health_upload_items(report_id,state) VALUES('target','pending');`);
  const course = createMedicationCourse(manager, { memberId: 'member', sourceMedicationId: 'prescription', startedAt: '2025-01-02', confirmed: true });
  const reminder = createReminder(manager, { memberId: 'member', reportId: 'report', title: '合成复查', dueAt: '2025-01-03', sourceEventId: event.id });
  const snapshot = db.prepare('SELECT source_snapshot_json FROM medication_courses WHERE id=?').get(course.id)!.source_snapshot_json;
  db.exec("CREATE TRIGGER fail_merge_workflow BEFORE UPDATE OF status ON reports WHEN NEW.status='trashed' BEGIN SELECT RAISE(ABORT,'synthetic merge failure'); END");
  assert.throws(() => mergeDuplicateReport(manager, 'report', 'target'), /synthetic merge failure/);
  assert.equal(getHealthEvent(manager, event.id).resources.length, 2); assert.equal(db.prepare('SELECT report_id FROM reminders WHERE id=?').get(reminder.id)!.report_id, 'report');
  db.exec('DROP TRIGGER fail_merge_workflow'); mergeDuplicateReport(manager, 'report', 'target');
  assert.deepEqual(getHealthEvent(manager, event.id).resources.map(item => item.resourceId), ['target']);
  assert.equal(db.prepare('SELECT report_id FROM reminders WHERE id=?').get(reminder.id)!.report_id, 'target');
  const preserved = db.prepare('SELECT source_report_id,source_medication_id,source_snapshot_json FROM medication_courses WHERE id=?').get(course.id)!;
  assert.equal(preserved.source_report_id, 'target'); assert.equal(preserved.source_medication_id, null); assert.equal(preserved.source_snapshot_json, snapshot);
  assert.equal(db.prepare("SELECT state FROM health_upload_items WHERE report_id='target'").get()!.state, 'archived');
  assert.equal(db.prepare("SELECT 1 FROM health_upload_items WHERE report_id='report'").get(), undefined);
  assert.deepEqual(validateHealthWorkflowDatabase(db), []); assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
}));

test('event dates reject calendar rollover and planned future occurrences', () => fixture(() => {
  for (const date of ['2025-02-29', '2024-02-30T10:00', '2025-01-01T24:00', '2025-04-31T12:00Z']) status(() => dateInput(date, '日期'), 400);
  assert.equal(dateInput('2024-02-29T23:59:59+08:00', '日期'), '2024-02-29T23:59:59+08:00');
  status(() => createHealthEvent(manager, { memberId: 'member', eventType: 'follow_up', startedAt: '2999-01-01' }), 400);
}));


test('lost creation response retries do not duplicate an event or leak a failed transaction receipt', () => fixture(db => {
  const input = { memberId: 'member', eventType: 'outpatient', title: '合成重试', requestKey: 'synthetic-create-request-01' };
  const saved = createHealthEvent(manager, input);
  assert.deepEqual(createHealthEvent(manager, input), saved);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_events').get()!.n, 1);
  status(() => createHealthEvent(manager, { ...input, title: '不同合成内容' }), 409);
  status(() => createHealthEvent(viewer, input), 403);
  assert.throws(() => runInTransaction(db, () => {
    createHealthEvent(manager, { ...input, requestKey: 'synthetic-create-request-02' });
    throw new Error('synthetic failure');
  }), /synthetic failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_workflow_requests').get()!.n, 1);
}));
