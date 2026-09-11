import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDatabase, closeDatabaseForTests } from '../database/client.ts';
import { createManualObservation, deleteManualObservation, applyObservationFieldOverrides } from '../services/observation-field-overrides.service.ts';

test('deletes only the managed report observation and its manual override', () => {
  const root = mkdtempSync(join(tmpdir(), 'observation-delete-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = root;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users (id, display_name) VALUES ('owner', '测试'), ('other', '测试');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('m', '测试', 'owner');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by) VALUES ('m','owner','manager','owner');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status) VALUES ('r','m','owner','laboratory','测试','ready'), ('r2','m','owner','laboratory','测试','ready');`);
    const user = { id: 'owner', displayName: '测试', provider: 'local' as const, authenticated: true, isGatewayAdmin: false };
    createManualObservation(user, 'r', { itemName: '合成指标', resultText: '42', numericValue: 42, unit: 'U/L' });
    const { id } = db.prepare('SELECT id FROM observations WHERE report_id=?').get('r') as {id:string};
    assert.throws(() => deleteManualObservation({ ...user, id: 'other' }, 'r', id));
    assert.throws(() => deleteManualObservation(user, 'r2', id));
    assert.ok(db.prepare('SELECT 1 FROM observations WHERE id=?').get(id));
    deleteManualObservation(user, 'r', id);
    assert.equal(db.prepare('SELECT 1 FROM observations WHERE id=?').get(id), undefined);
    assert.equal(db.prepare('SELECT 1 FROM observation_normalizations WHERE observation_id=?').get(id), undefined);
    assert.deepEqual(applyObservationFieldOverrides('r', []), []);
    assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='observation.manual_delete'").get());
    assert.throws(() => deleteManualObservation(user, 'r', id));
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
