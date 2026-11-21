import report from '../assets/health-categories/report.png';
import imaging from '../assets/health-categories/imaging.png';
import symptom from '../assets/health-categories/symptom.png';
import monitoring from '../assets/health-categories/monitoring.png';
import medication from '../assets/health-categories/medication.png';
import vaccination from '../assets/health-categories/vaccination.png';
import type { HealthCategory } from '../../../shared/health-categories';
export type HealthRecordHeading = { title: string; category: HealthCategory };
export const healthCategoryImages: Record<HealthCategory, string> = { report, imaging, symptom, monitoring, medication, vaccination };

// Navigation availability is independent of stored report categories.
export const healthCategoryOrder = ['report', 'symptom', 'monitoring', 'medication', 'vaccination', 'imaging'] as const satisfies readonly HealthCategory[];
export const isHealthCategoryDisabled = (category: HealthCategory) => category === 'imaging';

export const documentStatusMeta: Record<string, { label: string; chip: string }> = {
  uploading: { label: "上传中", chip: "chip--info" },
  queued: { label: "排队中", chip: "chip--info" },
  processing: { label: "处理中", chip: "chip--info" },
  needs_review: { label: "待确认", chip: "chip--amber" },
  ready: { label: "已归档", chip: "chip--green" },
  failed: { label: "识别失败", chip: "chip--red" },
  trashed: { label: "回收站", chip: "chip--plain" }
};
