import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { HealthResourceType } from '../../shared/health-events';

export type HealthResourceSummary = {
  resourceType: HealthResourceType;
  resourceId: string;
  memberId: string;
  title: string;
  date: string | null;
  status: string;
};

type ResourceResolver = {
  getResource(resourceId: string): HealthResourceSummary | null;
  getMemberId(resourceId: string): string | null;
  validateOwnership(resourceId: string, memberId: string): HealthResourceSummary;
  getSummary(resourceId: string): HealthResourceSummary | null;
};

function reportSummary(resourceId: string): HealthResourceSummary | null {
  const row = getDatabase().prepare(`
    SELECT id, member_id AS memberId, title,
      COALESCE(report_issued_at,reviewed_at,received_at,examined_at,sampled_at,ordered_at) AS date, status
    FROM reports WHERE id = ? AND status <> 'trashed'
  `).get(resourceId) as Omit<HealthResourceSummary, 'resourceType' | 'resourceId'> & { id: string } | undefined;
  return row ? { resourceType: 'report', resourceId: row.id, memberId: row.memberId,
    title: row.title, date: row.date, status: row.status } : null;
}

const reportResolver: ResourceResolver = {
  getResource: reportSummary,
  getMemberId: id => reportSummary(id)?.memberId || null,
  getSummary: reportSummary,
  validateOwnership(id, memberId) {
    const resource = reportSummary(id);
    if (!resource) throw createError({ statusCode: 404, statusMessage: '资料不存在' });
    if (resource.memberId !== memberId) throw createError({ statusCode: 403, statusMessage: '不能关联其他成员的资料' });
    return resource;
  }
};

const resolvers: Partial<Record<HealthResourceType, ResourceResolver>> = { report: reportResolver };

/** Future resource kinds plug in here without changing Event relation storage. */
export function healthResourceResolver(resourceType: HealthResourceType): ResourceResolver {
  const resolver = resolvers[resourceType];
  if (!resolver) throw createError({ statusCode: 400, statusMessage: '此类资料尚未支持关联事件' });
  return resolver;
}
