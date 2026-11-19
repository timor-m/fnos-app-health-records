export const healthEventTypes = [
  'physical_exam', 'outpatient', 'emergency', 'inpatient', 'screening',
  'diagnostic_exam', 'laboratory_exam', 'procedure', 'vaccination',
  'follow_up', 'rehabilitation_assessment', 'other'
] as const;

export type HealthEventType = typeof healthEventTypes[number];

export const healthResourceTypes = [
  'report', 'imaging_study', 'symptom_episode', 'self_monitoring_session',
  'follow_up_record', 'external_resource'
] as const;

export type HealthResourceType = typeof healthResourceTypes[number];
export const healthEpisodeTypes = ['symptom', 'rehabilitation', 'monitoring', 'other'] as const;
export type HealthEpisodeType = typeof healthEpisodeTypes[number];
export const healthEpisodeStatuses = ['active', 'ended', 'unknown'] as const;
export const healthEpisodeOutcomes = ['improved', 'resolved', 'unchanged', 'worsened', 'unknown'] as const;

export const healthSymptomChanges = ['worsened', 'unchanged', 'improved', 'resolved'] as const;
export type HealthSymptomChange = typeof healthSymptomChanges[number];
export const healthSymptomChangeLabels: Record<HealthSymptomChange, string> = {
  worsened: '加重', unchanged: '不变', improved: '减轻', resolved: '消失'
};
