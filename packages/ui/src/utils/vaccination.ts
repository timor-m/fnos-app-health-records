import type { VaccinationEntry } from '../../../shared/health-categories';
import type { ReportDetail, VaccinationRecord } from '../types/api';

export function vaccinationFromReport(report: ReportDetail, fact?: VaccinationRecord): Partial<VaccinationEntry> {
  return {
    sourceReportId: report.id, sourceFactId: fact?.id || null,
    vaccineName: fact?.vaccineName || '', administeredAt: fact?.administeredAt || undefined,
    doseNumber: fact?.doseNumber || null, organizationName: report.hospitalName || null,
    manufacturer: fact?.manufacturer || null, lotNumber: fact?.lotNumber || null,
    administrationSite: fact?.administrationSite || null, nextDueAt: fact?.nextDueAt || null,
  };
}

/** Return targets are local views, never arbitrary links or another creation form. */
export function vaccinationReturnTo(value: unknown, fallback = '/events'): string {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const url = new URL(value, 'https://health.invalid');
    if (url.origin !== 'https://health.invalid' || !(/^\/(events|overview|reminders|records)(\/|$)/.test(url.pathname) || /^\/health-processes(?:\/[^/]+)?$/.test(url.pathname))) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}
