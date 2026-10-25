import type { HealthProcessSummary } from './health-process';
import type { HealthCategory, HealthFeedEntry } from './health-categories';

export type OverviewReminder = {
  id: string; memberId: string; title: string; dueAt: string;
  reportId: string | null; reportTitle: string | null;
  vaccinationId: string | null;
};
export type HealthOverview = {
  memberId: string;
  recordCount: number;
  categoryCounts: Record<HealthCategory, number>;
  pending: {
    reminderCount: number; reminders: OverviewReminder[];
    reviewCount: number; processingCount: number; failedCount: number;
    documents: HealthFeedEntry[];
  };
  attention: {
    symptomCount: number; medicationCount: number;
    symptoms: HealthFeedEntry[]; medications: HealthFeedEntry[];
  };
  recentRecords: HealthFeedEntry[];
  processes: HealthProcessSummary[];
};
