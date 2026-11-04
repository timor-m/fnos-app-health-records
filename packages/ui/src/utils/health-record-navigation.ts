import type { HealthFeedEntry } from '../../../shared/health-categories';

export const healthRecordTitles: Record<HealthFeedEntry['kind'], string> = {
  symptom: '症状', vaccination: '接种', report: '资料详情',
  medication_document: '用药单', medication: '用药记录', intake: '用药记录'
};

export function isHealthRecordKind(value: unknown): value is HealthFeedEntry['kind'] {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(healthRecordTitles, value);
}

export function healthRecordPath(kind: HealthFeedEntry['kind'], id: string) {
  return `/events/detail/${kind}/${encodeURIComponent(id)}`;
}

/** Modal query changes share the underlying timeline's scroll position. */
export function healthPageScrollKey(fullPath: string, memberId: string) {
  const url = new URL(fullPath, 'https://health.invalid');
  if (url.pathname === '/events' || url.pathname === '/overview' || url.pathname.startsWith('/health-processes/')) {
    url.searchParams.delete('recordKind');
    url.searchParams.delete('recordId');
  }
  return JSON.stringify([memberId, `${url.pathname}${url.search}${url.hash}`]);
}
