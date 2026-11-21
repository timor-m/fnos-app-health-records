import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createMeasurement, getMeasurement, updateMeasurement } from '../services/measurement.service';
import { mutateStandaloneTrash } from '../services/health-record-trash.service';
import { healthRecordEntries } from '../services/health-record-feed.service';
import { computeTrendSeries } from '../services/records.service';

const manager: RequestUser = {
  id: 'manager',
  displayName: '合成账号',
  provider: 'development',
  authenticated: true,
  isGatewayAdmin: true,
};

function fixture(run: () => void) {
  const before = process.env.STORAGE_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'health-measurement-'));
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users(id,display_name) VALUES(?,?)').run(manager.id, '合成账号');
    db.prepare('INSERT INTO health_members(id,display_name,created_by) VALUES(?,?,?)').run('member', '合成成员', manager.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'manager','manager','manager')").run('member');
    run();
  } finally {
    closeDatabaseForTests();
    if (before === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('measurement ingest stores session, appears in feed and trends', () => fixture(() => {
  const created = createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'blood_pressure',
    recordedAt: '2026-03-01T08:00:00',
    requestKey: 'measurement-request-key-001234',
    samples: [
      { canonicalKey: 'vital_systolic_bp', value: 128, unit: 'mmHg', pairGroup: 'bp' },
      { canonicalKey: 'vital_diastolic_bp', value: 82, unit: 'mmHg', pairGroup: 'bp' },
      { canonicalKey: 'vital_pulse', value: 72, unit: '次/分' },
    ],
  });
  assert.equal(created.items.length, 3);
  assert.equal(getMeasurement(manager, created.id).revision, 1);

  const feed = healthRecordEntries(manager, { memberId: 'member', category: 'monitoring' });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].kind, 'measurement');
  assert.match(feed[0].description || '', /128\/82/);

  const trends = computeTrendSeries({ memberId: 'member', userId: manager.id });
  const systolic = trends.find((item) => item.indicatorKey === 'vital_systolic_bp');
  assert.ok(systolic);
  assert.equal(systolic!.points.some((point) => (point as { sourceKind?: string }).sourceKind === 'measurement'), true);

  const updated = updateMeasurement(manager, created.id, {
    revision: created.revision,
    recordedAt: '2026-03-01T09:00:00',
    samples: [
      { canonicalKey: 'vital_systolic_bp', value: 120, unit: 'mmHg', pairGroup: 'bp' },
      { canonicalKey: 'vital_diastolic_bp', value: 80, unit: 'mmHg', pairGroup: 'bp' },
    ],
  });
  assert.equal(updated.items.length, 2);
  assert.equal(updated.revision, 2);

  mutateStandaloneTrash(manager, 'measurement', created.id, { revision: updated.revision }, 'trash');
  assert.equal(healthRecordEntries(manager, { memberId: 'member', category: 'monitoring' }).length, 0);
}));

test('measurement search matches every indicator name, value and note', () => fixture(() => {
  createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'body_metrics',
    recordedAt: '2026-03-05T08:00:00',
    note: '合成备注',
    requestKey: 'measurement-search-key-0001',
    samples: [
      { canonicalKey: 'body_weight', value: 62.4, unit: 'kg' },
      { canonicalKey: 'body_height', value: 170, unit: 'cm' },
      { canonicalKey: 'body_waist_circumference', value: 76, unit: 'cm' },
      { canonicalKey: 'body_hip_circumference', value: 92, unit: 'cm' },
    ],
  });
  createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'blood_pressure',
    recordedAt: '2026-03-05T09:00:00',
    requestKey: 'measurement-search-key-0002',
    samples: [
      { canonicalKey: 'vital_systolic_bp', value: 128, unit: 'mmHg', pairGroup: 'bp' },
      { canonicalKey: 'vital_diastolic_bp', value: 82, unit: 'mmHg', pairGroup: 'bp' },
    ],
  });
  const find = (query: string) => healthRecordEntries(manager, { memberId: 'member', category: 'monitoring', query });
  assert.equal(find('臀围').length, 1);
  assert.equal(find('体重指数').length, 1);
  assert.equal(find('92').length, 1);
  assert.equal(find('合成备注').length, 1);
  assert.equal(find('收缩压').length, 1);
  assert.equal(find('没有这项').length, 0);
}));

test('measurement derives BMI when height and weight are entered together', () => fixture(() => {
  const created = createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'body_metrics',
    recordedAt: '2026-03-02T08:00:00',
    requestKey: 'measurement-request-key-002345',
    samples: [
      { canonicalKey: 'body_weight', value: 70, unit: 'kg' },
      { canonicalKey: 'body_height', value: 175, unit: 'cm' },
      { canonicalKey: 'body_hip_circumference', value: 96, unit: 'cm' },
    ],
  });
  const bmi = created.items.find((item) => item.canonicalKey === 'body_bmi');
  assert.ok(bmi);
  assert.equal(bmi!.origin, 'derived');
  assert.ok(Math.abs(bmi!.numericValue - 22.86) < 0.02);
  assert.ok(created.items.some((item) => item.canonicalKey === 'body_hip_circumference'));
}));

test('measurement converts compatible units before range checks and requires a complete blood pressure pair', () => fixture(() => {
  const glucose = createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'glucose',
    recordedAt: '2026-03-04T08:00:00',
    requestKey: 'measurement-request-key-004567',
    samples: [{ canonicalKey: 'glucose_fasting', value: 100, unit: 'mg/dL' }],
  });
  assert.ok(Math.abs((glucose.items[0].canonicalValue ?? 0) - 100 / 18.018) < 0.01);
  assert.throws(() => createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'glucose',
    recordedAt: '2026-03-04T09:00:00',
    requestKey: 'measurement-request-key-004568',
    samples: [{ canonicalKey: 'glucose_fasting', value: 900, unit: 'mg/dL' }],
  }), /超出合理范围/);

  const body = createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'body_metrics',
    recordedAt: '2026-03-04T10:00:00',
    requestKey: 'measurement-request-key-004569',
    samples: [
      { canonicalKey: 'body_height', value: 1.75, unit: 'm' },
      { canonicalKey: 'body_weight', value: 70000, unit: 'g' },
    ],
  });
  assert.equal(body.items.find((item) => item.canonicalKey === 'body_height')?.canonicalValue, 175);
  assert.equal(body.items.find((item) => item.canonicalKey === 'body_weight')?.canonicalValue, 70);

  assert.throws(() => createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'blood_pressure',
    recordedAt: '2026-03-04T11:00:00',
    requestKey: 'measurement-request-key-004570',
    samples: [{ canonicalKey: 'vital_pulse', value: 70, unit: '次/分' }],
  }), /同时填写/);
}));

test('measurement oxygen stores SpO2 and appears in trends', () => fixture(() => {
  const created = createMeasurement(manager, {
    memberId: 'member',
    channel: 'manual',
    templateId: 'oxygen',
    recordedAt: '2026-03-03T08:00:00',
    requestKey: 'measurement-request-key-003456',
    samples: [{ canonicalKey: 'vital_spo2', value: 98, unit: '%' }],
  });
  assert.equal(created.items.length, 1);
  assert.equal(created.items[0].canonicalKey, 'vital_spo2');
  const trends = computeTrendSeries({ memberId: 'member', userId: manager.id });
  const spo2 = trends.find((item) => item.indicatorKey === 'vital_spo2');
  assert.ok(spo2);
  assert.equal(spo2!.points.some((point) => (point as { sourceKind?: string }).sourceKind === 'measurement'), true);
}));
