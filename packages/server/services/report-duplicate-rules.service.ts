export const familyReportDuplicateRuleVersion = "family-v2";

export type ReportDuplicateRuleVersion = string;

export type ReportDuplicateRuleSelection = {
  version: ReportDuplicateRuleVersion;
  activeVersion: ReportDuplicateRuleVersion;
  candidateVersion: ReportDuplicateRuleVersion;
  source: "fixed";
};

export type ReportDuplicateRuleSnapshot = {
  version: ReportDuplicateRuleVersion;
  ruleId: string;
  signals: string[];
  signalProfileKey: string;
};

export const stableReportDuplicateRuleVersion = familyReportDuplicateRuleVersion;
export const currentReportDuplicateRuleVersion = familyReportDuplicateRuleVersion;

export function isReportDuplicateRuleVersion(value: unknown): value is ReportDuplicateRuleVersion {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveReportDuplicateRuleSelection(): ReportDuplicateRuleSelection {
  return {
    version: familyReportDuplicateRuleVersion,
    activeVersion: familyReportDuplicateRuleVersion,
    candidateVersion: familyReportDuplicateRuleVersion,
    source: "fixed"
  };
}

export function normalizeReportDuplicateRuleSnapshot(
  value: unknown,
  fallbackRuleId = "manual.governance"
): ReportDuplicateRuleSnapshot {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const version = isReportDuplicateRuleVersion(record.version)
    ? record.version
    : currentReportDuplicateRuleVersion;
  const signals = Array.isArray(record.signals)
    ? [...new Set(record.signals.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20)
    : [];
  const ruleId = String(record.ruleId || fallbackRuleId).trim().slice(0, 100) || fallbackRuleId;
  const signalProfileKey = String(record.signalProfileKey || signals.join("|")).trim().slice(0, 500);
  return { version, ruleId, signals, signalProfileKey };
}
