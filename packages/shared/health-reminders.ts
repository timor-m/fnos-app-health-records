export type Reminder = {
  relatedRecord?:import('./health-record-associations').HealthRecordRef|null;
  completedRecord?:import('./health-record-associations').HealthRecordRef|null;
  processes?:import('./health-process').HealthProcessSummary[];
  id: string;
  memberId: string;
  reportId: string | null;
  title: string;
  dueAt: string;
  status: "pending" | "completed" | "dismissed";
  source: "manual" | "report_suggestion";
  reportTitle: string | null;
  reportHospitalName: string | null;
  reportIssuedAt: string | null;
  vaccinationId?: string | null;
  completedVaccinationId?: string | null;
};
