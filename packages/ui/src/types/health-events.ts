import type { HealthEpisodeType } from '../../../shared/health-events';

export type HealthEpisodeSummary = {
  id: string; memberId: string; episodeType: HealthEpisodeType; title: string;
  startedAt: string | null; endedAt: string | null;
  status: 'active' | 'ended' | 'unknown';
  outcome: 'improved' | 'resolved' | 'unchanged' | 'worsened' | 'unknown' | null;
  description: string | null;
};

export type HealthEpisodeDetail = HealthEpisodeSummary & {
  symptoms: HealthProcessSymptom[];
};

export type HealthProcessSymptomUpdate = {
  id: string; symptomId: string; recordedAt: string;
  change: 'worsened' | 'unchanged' | 'improved' | 'resolved' | null;
  severity: number | null; measurementValue: string | null; measurementUnit: string | null;temperatureValue?:string|null;
  description: string | null; version: number; deletedAt: string | null; createdAt: string;
};
export type HealthProcessSymptom = {
  id: string; episodeId: string; name: string; startedAt: string | null;
  status: 'active' | 'resolved' | 'unknown'; endedAt: string | null;
  bodyArea: string | null; severity: number | null; currentSeverity: number | null;
  frequency: string | null; description: string | null; triggerText: string | null;
  relievingText: string | null; associatedSymptomsText: string | null;
  version: number; updates: HealthProcessSymptomUpdate[];
};
