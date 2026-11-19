import { createError } from 'h3';
import { getDatabase, runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { createId } from '../utils/identifier';
import { memberAccessSql, assertMemberAccess, assertMemberManage } from './member.service';
import { healthEventTypes, type HealthEventType, type HealthResourceType } from '../../shared/health-events';
import { healthResourceResolver } from './health-resource-resolver.service';
import { assertDateOrder, assertOccurredDate, dateInput, enumInput, hasInput, textInput } from './health-event-input';
import { runHealthWorkflowRequest } from './health-workflow-request.service';

export type HealthEventRow = {
  id: string; memberId: string; eventType: HealthEventType; title: string | null;
  startedAt: string | null; endedAt: string | null; organizationName: string | null;
  organizationId: string | null; department: string | null; reason: string | null;
  status: string; source: string; createdBy: string | null;
  createdAt: string; updatedAt: string;
};

const eventColumns = `id, member_id AS memberId, event_type AS eventType, title,
  started_at AS startedAt, ended_at AS endedAt, organization_name AS organizationName,
  organization_id AS organizationId, department, reason, status, source,
  created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt`;

export function activeHealthEvent(id: string): HealthEventRow {
  const row = getDatabase().prepare(`SELECT ${eventColumns} FROM health_events WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as HealthEventRow | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: '事件不存在' });
  return row;
}

function audit(user: RequestUser, action: string, id: string, detail: Record<string, unknown> = {}) {
  getDatabase().prepare(`INSERT INTO audit_logs(id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES(?, ?, ?, 'health_event', ?, ?)`).run(createId('audit'), user.id, action, id, JSON.stringify(detail));
}

function eventFields(input: Record<string, unknown>, existing?: HealthEventRow) {
  const eventType = hasInput(input, 'eventType')
    ? enumInput(input.eventType, healthEventTypes, '事件类型') : existing?.eventType;
  if (!eventType) throw createError({ statusCode: 400, statusMessage: '事件类型不能为空' });
  const title = hasInput(input, 'title') ? textInput(input.title, '标题', 120) : existing?.title ?? null;
  const startedAt = hasInput(input, 'startedAt') ? dateInput(input.startedAt, '开始时间') : existing?.startedAt ?? null;
  const endedAt = hasInput(input, 'endedAt') ? dateInput(input.endedAt, '结束时间') : existing?.endedAt ?? null;
  assertDateOrder(startedAt, endedAt);
  assertOccurredDate(startedAt, '事件开始时间');
  assertOccurredDate(endedAt, '事件结束时间');
  return {
    eventType, title, startedAt, endedAt,
    organizationName: hasInput(input, 'organizationName')
      ? textInput(input.organizationName, '机构', 120) : existing?.organizationName ?? null,
    department: hasInput(input, 'department')
      ? textInput(input.department, '科室', 100) : existing?.department ?? null,
    reason: hasInput(input, 'reason')
      ? textInput(input.reason, '原因', 1000) : existing?.reason ?? null,
  };
}

export function getHealthEvent(user: RequestUser, id: string) {
  const event = activeHealthEvent(id);
  assertMemberAccess(user, event.memberId);
  const db = getDatabase();
  const links = db.prepare(`SELECT id, resource_type AS resourceType, resource_id AS resourceId,
    relation_type AS relationType, sort_order AS sortOrder, created_at AS createdAt
    FROM health_event_resources WHERE event_id = ? ORDER BY sort_order, created_at, id`)
    .all(id) as Array<{ id: string; resourceType: HealthResourceType; resourceId: string;
      relationType: string; sortOrder: number; createdAt: string }>;
  const resources = links.map(link => {
    try { return { ...link, summary: healthResourceResolver(link.resourceType).getSummary(link.resourceId) }; }
    catch { return { ...link, summary: null }; }
  });
  return {...event,resources};
}

export function createHealthEvent(user: RequestUser, input: Record<string, unknown>) {
  const memberId = textInput(input.memberId, '成员', 100, true)!;
  assertMemberManage(user, memberId);
  return runHealthWorkflowRequest(user, memberId, 'event.create', input, () => {
  const fields = eventFields(input);
  const reportIds = input.reportIds === undefined ? [] : input.reportIds;
  if (!Array.isArray(reportIds) || reportIds.length > 50
    || reportIds.some(id => typeof id !== 'string' || !id || id.length > 100)
    || new Set(reportIds).size !== reportIds.length)
    throw createError({ statusCode: 400, statusMessage: '关联资料列表无效' });
  for (const reportId of reportIds) healthResourceResolver('report').validateOwnership(reportId as string, memberId);
  const id = createId('event');
  const db = getDatabase();
  runInTransaction(db, () => {
    db.prepare(`INSERT INTO health_events(id, member_id, event_type, title, started_at, ended_at,
      organization_name, department, reason, created_by)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, memberId, fields.eventType, fields.title, fields.startedAt, fields.endedAt,
        fields.organizationName, fields.department, fields.reason, user.id);
    for (const [index, reportId] of reportIds.entries()) {
      db.prepare(`INSERT INTO health_event_resources(id, event_id, resource_type, resource_id,
        relation_type, sort_order, created_by) VALUES(?, ?, 'report', ?, ?, ?, ?)`)
        .run(createId('event_resource'), id, reportId as string, index === 0 ? 'primary' : 'related', index, user.id);
    }
    audit(user, 'event.create', id, { memberId, eventType: fields.eventType, reportCount: reportIds.length });
  });
  return getHealthEvent(user, id);
  }, saved => getHealthEvent(user, saved.id));
}
