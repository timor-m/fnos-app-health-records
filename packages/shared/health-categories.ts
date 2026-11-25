/** Public content categories; storage objects and process links are not user categories. */
export const healthCategories = ['report', 'imaging', 'symptom', 'monitoring', 'medication', 'vaccination'] as const;
export type HealthCategory = typeof healthCategories[number];
export const healthCategoryLabels: Record<HealthCategory, string> = {
  report: '报告', imaging: '影像', symptom: '症状', monitoring: '监测', medication: '用药', vaccination: '接种'
};
export function isHealthCategory(value: unknown): value is HealthCategory {
  return typeof value === 'string' && (healthCategories as readonly string[]).includes(value);
}
export function reportCategory(reportType: string): HealthCategory {
  if (reportType === 'imaging') return 'imaging';
  if (reportType === 'prescription') return 'medication';
  if (reportType === 'vaccination') return 'vaccination';
  return 'report';
}
export type VaccinationEntry = {
  id: string; memberId: string; vaccineName: string; doseNumber: string | null;
  administeredAt: string; organizationName: string | null; manufacturer: string | null;
  lotNumber: string | null; administrationSite: string | null; note: string | null;
  nextDueAt: string | null; reminderId: string | null; completedReminderId: string | null; sourceReportId: string | null; sourceFactId: string | null;
  revision: number; deletedAt: string | null;
  reminderStatus?: 'pending' | 'completed' | 'dismissed' | null; nextVaccinationId?: string | null;
};

export type HealthDocument = {
  id: string; memberId: string; title: string; reportType: string; status: string;
  reportIssuedAt: string | null; hospitalName: string | null; department: string | null;
};
export type HealthFeedEntry = {
  id: string; category: HealthCategory; kind: 'report' | 'symptom' | 'medication_document' | 'medication' | 'intake' | 'vaccination' | 'measurement';
  resourceId: string; memberId: string; title: string; date: string | null; subtype: string;
  uploadedAt?: string | null;
  duplicateHint?: 'high' | 'possible';
  description: string | null; status: string | null; institution: string | null;
  documents: HealthDocument[]; processIds: string[]; groupId?: string;
  medicationCount?: number; formulaCount?: number; activeCount?: number; confirmedCount?: number; intakeCount?: number;
  episodeId?: string; symptomId?: string;
  doseNumber?: string | null; note?: string | null;
  metrics?: Array<{ label: string; value: string; unit: string }>;
};
export type HealthFeedPage = {items: HealthFeedEntry[]; nextCursor: string | null; hasMore: boolean};

export const healthSubtypeOptions: Record<HealthCategory, readonly (readonly [string,string])[]> = {
  report:[['checkup','体检'],['laboratory','检验'],['pathology','病理'],['functional','功能检查'],['ultrasound','超声检查'],['outpatient','门诊病历'],['inpatient','住院资料'],['billing','费用凭证'],['other','其他资料']],
  imaging:[],symptom:[],
  // Device/import ingest has no user entry yet; keep only the category chip until those channels ship.
  monitoring:[],
  medication:[['prescription','用药单'],['record','用药记录']],vaccination:[]
};
