import type { HealthFeedEntry } from './health-categories';

export const untitledHealthProcessTitle = '待命名健康历程';
export type ProcessRecordRef = { kind: HealthFeedEntry['kind']; id: string };
export const processStages = ['symptom', 'consultation', 'examination', 'treatment', 'medication', 'vaccination', 'followup', 'other'] as const;
export type ProcessStage = typeof processStages[number];
export const processStageLabels: Record<ProcessStage, string> = {
  symptom: '症状', consultation: '就诊', examination: '检查', treatment: '治疗',
  medication: '用药', vaccination: '接种', followup: '复查', other: '其他记录'
};
export type ProcessRecord = {
  ref: ProcessRecordRef; title: string; date: string | null; latestDate: string | null;
  category: HealthFeedEntry['category']; stage: ProcessStage; stageSource: 'record' | 'manual' | 'ai';
  description: string | null; institution: string | null; version: string;
};
export const processLifecycleLabels={unknown:'未标记',active:'进行中',resolved:'已结束',chronic:'持续管理'} as const;
export type ProcessLifecycle={status:keyof typeof processLifecycleLabels;onsetAt:string|null;endedAt:string|null};
export type ProcessHighlight = { text: string; sources: ProcessRecordRef[] };
export type HealthProcessSummary = {
  id: string; memberId: string; title: string; summary: string | null;
  startedAt: string | null; latestAt: string | null; recordCount: number;
  aiState: 'unconfigured' | 'idle' | 'pending' | 'ready' | 'stale' | 'failed';
  manuallyEdited: boolean;
  lifecycle?:ProcessLifecycle;
};
export type HealthProcessPage = {
  items: HealthProcessSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
};
export type HealthProcessDetail = HealthProcessSummary & {
  records: ProcessRecord[];
  links: Array<{ source: ProcessRecordRef; target: ProcessRecordRef }>;
  highlights: ProcessHighlight[];
  fingerprint: string;
  editToken: string;
};
export type ProcessRecordRemoval = {
  memberId: string;
  removed: ProcessRecordRef;
  process: HealthProcessDetail | null;
};
