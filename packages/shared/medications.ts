export const medicationActions = ['start', 'adjust', 'pause', 'resume', 'stop'] as const;
export type MedicationAction = typeof medicationActions[number];
export type MedicationStatus = 'active' | 'paused' | 'stopped';
export const medicationActionLabels: Record<MedicationAction, string> = {
  start: '开始', adjust: '调整', pause: '暂停', resume: '恢复', stop: '停止'
};
export const medicationStatusLabels: Record<MedicationStatus, string> = {
  active: '正在使用', paused: '已暂停', stopped: '已停止'
};
export type MedicationFields = {
  medicationName: string; specification: string | null; dosageForm: string | null;
  dose: string | null; doseUnit: string | null;
  frequency: string | null; route: string | null; instructions: string | null;
};
export type MedicationContext = { processId?:string; relatedRecords?: import('./health-record-associations').HealthRecordRef[] };
export type MedicationDocument = MedicationContext & {
  id: string; memberId: string; title: string; reportType: 'prescription'; status: string;
  date: string | null; medicationCount: number; formulaCount?: number; medicationNames: string[];
  ingredientNames?: string[];
};
export type MedicationSource = MedicationFields & {
  formula?: import('./medication-formula').MedicationFormula | null;
  reportId: string; reportTitle: string; reportIssuedAt: string | null;
  medicationId: string; duration: string | null;
};
export type MedicationChange = {
  id: string; action: MedicationAction; occurredAt: string; note: string | null;
  revision: number; snapshot: MedicationFields & { status: MedicationStatus };
};
export type MedicationCourse = MedicationFields & MedicationContext & {
  id: string; memberId: string; status: MedicationStatus; startedAt: string;
  lastChangedAt: string; stoppedAt: string | null; revision: number;
  sourceReportId: string | null; source: MedicationSource | null;
  changes: MedicationChange[];
};
export type MedicationIntake = MedicationContext & {
  id: string; memberId: string; courseId: string | null; medicationName: string;
  sourceReportId?: string | null; source?: MedicationSource | null;
  specification: string | null; dosageForm: string | null; route: string | null;
  takenAt: string; amount: string; amountUnit: string | null; note: string | null;
  revision: number;
  history: Array<{ operation: 'edit'; recordedAt: string; snapshot: Record<string, unknown> }>;
};
export type MedicationOverview = { courses: MedicationCourse[]; intakes: MedicationIntake[] };
export type HistoricalMedication = MedicationSource & {
  confirmedCourseIds: string[];
};
