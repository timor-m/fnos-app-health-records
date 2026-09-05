export type ApiResponse<T> = {
  ok: boolean;
  data: T;
  meta?: Record<string, unknown>;
  statusMessage?: string;
  statusText?: string;
  message?: string;
  error?: boolean | { message?: string };
};

export type Session = {
  id: string;
  appName: string;
  displayName: string;
  provider: "fnos_gateway" | "local" | "development";
  authenticated: boolean;
  isAdmin: boolean;
  mustChangePassword: boolean;
  /** @deprecated Kept while older servers and clients use this field. */
  isGatewayAdmin: boolean;
  authMode: "fnos" | "local" | "development" | "disabled";
  setupRequired: boolean;
};

export type HealthMember = {
  id: string;
  displayName: string;
  relationship: string;
  birthDate: string | null;
  sex: string | null;
  bloodTypeAbo: "A" | "B" | "AB" | "O" | null;
  bloodTypeRh: "positive" | "negative" | null;
  bloodTypeSourceReportId: string | null;
  avatarPath: string | null;
  permission: "viewer" | "manager";
};

export type BackupSummary = {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  appVersion: string;
  schemaVersion: number;
  reportCount: number;
  memberCount: number;
  includes: string[];
  reason: "manual" | "pre_restore";
  fileCount?: number;
};

export type BackupValidationResult = {
  valid: boolean;
  checksumAvailable: boolean;
  fileCount: number;
  checkedCount: number;
  missingFiles: string[];
  mismatchedFiles: Array<{
    path: string;
    expectedSha256?: string;
    actualSha256?: string;
    expectedSizeBytes?: number;
    actualSizeBytes?: number;
  }>;
  extraFiles: string[];
  warnings: string[];
  errors: string[];
  manifest: {
    id: string | null;
    appName: string | null;
    appTitle: string | null;
    appVersion: string | null;
    schemaVersion: number | null;
    createdAt: string | null;
    reason: string | null;
    reportCount: number | null;
    memberCount: number | null;
  } | null;
};

export type AccessUser = {
  id: string;
  displayName: string;
  isAdmin: number;
  providers: string | null;
};

export type LocalAccount = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  isAdmin: number;
  mustChangePassword: number;
  disabledAt: string | null;
};

export type MemberAccess = {
  userId: string;
  displayName: string;
  permission: "viewer" | "manager";
  providers: string | null;
};

export type ReportSummary = {
  id: string;
  memberId: string;
  title: string;
  reportType: string;
  status: string;
  hospitalName: string | null;
  hospitalBranch: string | null;
  departmentName: string | null;
  bodyPart: string | null;
  reportIssuedAt: string | null;
  abnormalCount: number;
  pageCount: number;
};

export type DuplicateReportCandidate = ReportSummary & {
  pairKey: string;
  governanceDecision: "duplicate" | null;
  confidence: "high" | "medium";
  matchedFields: string[];
  reason: string;
  ruleSnapshot: {
    version: string;
    ruleId: string;
    signals: string[];
    signalProfileKey: string;
  };
};

export type DuplicateReportGroup = {
  report: ReportSummary;
  candidates: DuplicateReportCandidate[];
};

export type ReportDuplicateMetrics = {
  candidateGroups: number;
  candidatePairs: number;
  highCandidates: number;
  mediumCandidates: number;
  sameOriginalCandidates: number;
  manualDuplicateDecisions: number;
  manualDistinctDecisions: number;
  totalDecisionHistory: number;
  duplicateConfirmRate: number;
  distinctRejectRate: number;
  mergedPairs: number;
  sourceReportsScanned: number;
  candidateComparisons: number;
  governedCandidateOverrides: number;
  scanDurationMs: number;
  scanPolicy: {
    sourceReportLimit: number;
    candidateWindowLimit: number;
    automaticCandidateReturnLimit: number;
  };
};

export type ReportDuplicateComparison = {
  left: Pick<ReportSummary, "id" | "title" | "reportType" | "status" | "hospitalName" | "hospitalBranch" | "departmentName" | "bodyPart" | "reportIssuedAt" | "pageCount">;
  right: Pick<ReportSummary, "id" | "title" | "reportType" | "status" | "hospitalName" | "hospitalBranch" | "departmentName" | "bodyPart" | "reportIssuedAt" | "pageCount">;
  fields: Array<{
    key: string;
    label: string;
    left: string | null;
    right: string | null;
    equal: boolean;
  }>;
  observations: {
    leftCount: number;
    rightCount: number;
    shared: number;
    conflicts: number;
    leftOnly: number;
    rightOnly: number;
    truncated: boolean;
    differences: Array<{
      key: string;
      itemName: string;
      status: "conflict" | "left_only" | "right_only";
      leftResult: string | null;
      rightResult: string | null;
    }>;
  };
};

export type ReportDuplicateBatchResult = {
  memberId: string;
  applied: number;
  duplicateCount: number;
  distinctCount: number;
  pairKeys: string[];
};

export type ReportDuplicateBatchUndoResult = {
  memberId: string;
  undone: number;
  pairKeys: string[];
};

export type ReportDuplicateOperationRecord = {
  id: string;
  operation: "scan" | "recompute" | "rollback_drill";
  memberId: string;
  ruleVersion: string | null;
  status: "running" | "completed" | "failed";
  purpose: string;
  stats: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
};

export type DuplicateReportOverview = {
  groups: DuplicateReportGroup[];
  decisions: ReportDuplicateDecisionRecord[];
  metrics: ReportDuplicateMetrics;
  operations: ReportDuplicateOperationRecord[];
  pagination: {
    page: number;
    pageSize: number;
    totalGroups: number;
    totalPairs: number;
    totalPages: number;
  };
  filterOptions: {
    reportTypes: string[];
    hospitals: string[];
  };
};

export type ReportDuplicateDecisionRecord = {
  pairKey: string;
  memberId: string;
  leftReportId: string;
  leftTitle: string;
  leftStatus: string;
  rightReportId: string;
  rightTitle: string;
  rightStatus: string;
  decision: "duplicate" | "distinct";
  reason: string | null;
  evidence: Record<string, unknown>;
  ruleVersion: string;
  ruleSnapshot: {
    version: string;
    ruleId: string;
    signals: string[];
    signalProfileKey: string;
  };
  decidedBy: string | null;
  decidedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportSummaryStats = {
  totalReports: number;
  readyReports: number;
  needsReviewReports: number;
  processingReports: number;
  failedReports: number;
  totalPages: number;
  observationCount: number;
  abnormalObservationCount: number;
  latestReportIssuedAt: string | null;
};

export type OverviewSummary = {
  stats: ReportSummaryStats;
  pendingReminders: Reminder[];
  recentReadyReports: ReportSummary[];
  unfiledReports: ReportSummary[];
};

export type ReportPage = {
  id: string;
  reportId: string;
  pageNumber: number;
  originalName: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  rotation: number;
  sourcePageNumber: number | null;
  sourcePageCount: number | null;
  hasThumbnail: boolean | number;
};

export type ProcessingJob = {
  id: string;
  pageId: string | null;
  pageNumber: number | null;
  originalName: string | null;
  jobType: "pdf_extract" | "thumbnail" | "ocr" | "ai_extract";
  pipelineVersion: string;
  batchId: string;
  batchKind: "initial_upload" | "manual_reprocess" | "manual_ai";
  batchStartedAt: string;
  batchSequence: number;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ocrEngine: string | null;
  ocrModelVersion: string | null;
  ocrElapsedMs: number | null;
  ocrTextLength: number | null;
  ocrQualityLevel: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiElapsedMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  aiRequestCount?: number;
  aiSuccessCount?: number;
  aiFailureCount?: number;
  plannedUnits?: number;
  completedUnits?: number;
  warningUnits?: number;
  processedPages?: number;
  totalPages?: number;
  currentUnitType?: "complete_pages" | "page_chunk" | "supplement" | null;
  currentPages?: number[];
  unmatchedCandidates?: number | null;
};

export type ProcessingJobEvent = {
  id: string;
  jobId: string;
  reportId: string;
  eventType: "queued" | "started" | "completed" | "retry_scheduled" | "failed" | "manual_retry" | "cancelled";
  status: string;
  attempt: number;
  message: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type AiExtractionUnitProgress = {
  id: string;
  unitKey: string;
  unitIndex: number;
  unitType: "complete_pages" | "page_chunk" | "supplement";
  pageNumbers: number[];
  status: "planned" | "processing" | "completed" | "warning" | "failed";
  attempts: number;
  model: string | null;
  characterCount: number;
  candidateCount: number;
  matchedCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  elapsedMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  events: ProcessingJobEvent[];
};

export type ProcessingDiagnosticReasonCode =
  | "OCR_RUNTIME_UNAVAILABLE"
  | "OCR_FAILED"
  | "OCR_EMPTY"
  | "OCR_LOW_QUALITY"
  | "AI_CALL_FAILED"
  | "AI_INVALID_OUTPUT"
  | "AI_TRUNCATED_OUTPUT"
  | "AI_PARTIAL_RESULT"
  | "SUPPLEMENT_REQUIRED"
  | "SUPPLEMENT_UNRESOLVED"
  | "POSTPROCESS_REDUNDANT"
  | "POSTPROCESS_IGNORED"
  | "POSTPROCESS_UNVERIFIED";

export type ProcessingDiagnosticReviewItem = {
  id: string;
  issueType: "ocr_content" | "ai_missing" | "layout_ambiguity" | "evidence_rejected";
  severity: "warning" | "error";
  title: string;
  description: string;
  pages: number[];
  candidateKind: "scalar" | "morphology" | null;
  sourceLineIds: string[];
  resultSummary: string;
  reason: string;
};

export type ProcessingJobDiagnostics = {
  stage: "local_processing" | "ocr" | "ai_planning" | "ai_call" | "supplement" | "post_processing" | "completed";
  outcome: "running" | "success" | "warning" | "failed" | "empty";
  headline: string;
  reasons: Array<{
    code: ProcessingDiagnosticReasonCode;
    severity: "info" | "warning" | "error";
    message: string;
    pages: number[];
  }>;
  reviewItems: ProcessingDiagnosticReviewItem[];
  metrics: {
    pageCount: number;
    ocrCompletedPages: number;
    ocrEmptyPages: number;
    ocrWeakPages: number;
    ocrFailedPages: number;
    plannedUnits: number;
    completedUnits: number;
    warningUnits: number;
    failedUnits: number;
    supplementUnits: number;
    supplementPages: number[];
    inputCharacters: number;
    candidateCount: number;
    matchedCount: number;
    resolvedCandidateCount: number;
    candidateClosurePercent: number;
    localExtractedCount: number;
    aiExtractedCount: number;
    redundantCount: number;
    ignoredCount: number;
    unresolvedCount: number;
    persistedObservationCount: number;
    trendReadyObservationCount: number;
    trendSeriesCount: number;
    aiRequestCount: number;
    aiFailureCount: number;
    postprocessRejectedCount: number;
    rejectedObservations: number;
    rejectedMorphologyFindings: number;
    rejectedClinicalFacts: number;
    rejectedStructuredSections: number;
  };
  supplement: {
    required: boolean;
    pages: number[];
    reason: string | null;
  };
};

export type ProcessingJobEventDetail = {
  job: {
    id: string;
    reportId: string;
    jobType: ProcessingJob["jobType"];
    status: ProcessingJob["status"];
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  units: AiExtractionUnitProgress[];
  generalEvents: ProcessingJobEvent[];
  diagnostics: ProcessingJobDiagnostics;
};

export type OcrPageText = {
  pageId: string;
  pageNumber: number;
  originalName: string;
  engine: string | null;
  modelVersion: string | null;
  elapsedMs: number | null;
  qualityScore: number | null;
  qualityLevel: "good" | "weak" | "poor" | null;
  qualityReason: string | null;
  lineCount: number;
  text: string;
};

export type OcrLineDetail = {
  id: string;
  text: string;
  confidence: number;
  box: number[] | null;
};

export type OcrPageDetail = {
  pageId: string;
  pageNumber: number;
  engine: string | null;
  modelVersion: string | null;
  coordWidth: number | null;
  coordHeight: number | null;
  lines: OcrLineDetail[];
};

export type ObservationEvidence = {
  pageId: string;
  lineIds: string[];
  sourceText: string;
  confidence: number | null;
};

export type Observation = {
  id: string;
  reportId: string;
  sectionName: string | null;
  itemCode?: string | null;
  itemName: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  referenceStatus: "trusted" | "raw_only" | "missing";
  referenceReason: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  reportedAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  abnormalSource: "stored" | "result_marker" | "marker_column" | "evidence_marker" | "qualitative_result" | "reference_range" | "none";
  abnormalStatus: "reported" | "computed" | "conflict" | "unresolved";
  abnormalConflict: boolean;
  abnormalReason: string | null;
  evidence: ObservationEvidence | null;
  canonicalName: string | null;
  canonicalKey: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  canonicalExplanation: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationConfidence: number | null;
  normalizationReason: string | null;
  normalizationExcludedReason: string | null;
  displayTier: "primary" | "secondary" | "governance_only";
  displayCategory: "standardized" | "medical_candidate" | "technical_measurement" | "qualitative_finding" | "governance_noise";
  displayReason: string | null;
  manualReviewed?: boolean;
  manualCreated?: boolean;
  manualCanonicalKey?: string | null;
};

export type MorphologyFinding = {
  id: string;
  reportId: string;
  examDate: string | null;
  sectionName: string | null;
  organ: string | null;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  findingName: string;
  presence: "present" | "absent" | "uncertain";
  findingCount: number | null;
  size: {
    length: number | null;
    width: number | null;
    height: number | null;
    unit: string | null;
  };
  measurements: Array<{ key: string; value: number; unit: string | null }>;
  morphology: string | null;
  attributes: Record<string, string>;
  classification: {
    system: string | null;
    value: string | null;
    text: string | null;
  } | null;
  comparisonText: string | null;
  rawText: string;
  evidence: Array<{ pageNumber: number; quote: string }>;
  confidence: number | null;
  trackingGroupId: string | null;
  matchConfidence: number | null;
  source: "ai" | "manual" | "legacy_migration";
  manualFields: string[];
};

export type MorphologyTrackingPoint = {
  findingId: string;
  reportId: string;
  reportTitle: string;
  reportStatus: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  findingName: string;
  organ: string | null;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  presence: "present" | "absent" | "uncertain";
  size: {
    length: number | null;
    width: number | null;
    height: number | null;
    unit: string | null;
    label: string | null;
    primaryMm: number | null;
  };
  morphology: string | null;
  classification: {
    system: string | null;
    value: string | null;
    text: string | null;
    label: string;
  } | null;
  comparisonText: string | null;
  rawText: string;
  evidenceQuote: string | null;
  matchConfidence: number | null;
  manualFields: string[];
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type MorphologyTrackingSeries = {
  trackingGroupId: string;
  name: string;
  organ: string;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  findingType: string;
  pointCount: number;
  firstDate: string | null;
  lastDate: string | null;
  latest: MorphologyTrackingPoint;
  previous: MorphologyTrackingPoint | null;
  changeKind:
    | "baseline"
    | "size_increased"
    | "size_decreased"
    | "size_stable"
    | "presence_changed"
    | "classification_changed"
    | "description_changed";
  changeSummary: string;
  points: MorphologyTrackingPoint[];
};

export type UntrackedMorphologyFinding = {
  findingId: string;
  reportId: string;
  reportTitle: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  findingName: string;
  organ: string | null;
  findingType: string;
  region: string | null;
  laterality: "left" | "right" | "bilateral" | "midline" | "unspecified";
  presence: "present" | "absent" | "uncertain";
  size: MorphologyTrackingPoint["size"];
  morphology: string | null;
  classification: MorphologyTrackingPoint["classification"];
  rawText: string;
  manualFields: string[];
  reason: string;
};

export type MorphologyTrackingResponse = {
  ruleVersion: string;
  summary: {
    groups: number;
    multiRecordGroups: number;
    findings: number;
    untracked: number;
  };
  series: MorphologyTrackingSeries[];
  untracked: UntrackedMorphologyFinding[];
};

export type TrendExcludedPoint = {
  observationId: string;
  reportId: string;
  reportTitle: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  itemName: string;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  reason: string;
  quality: "low" | "excluded";
  evidenceQuote: string | null;
  sourceLineIds: string[];
  resultLineIds: string[];
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type TrendPoint = {
  observationId: string;
  reportId: string;
  reportTitle: string;
  reportStatus: string;
  reportIssuedAt: string | null;
  hospitalName: string | null;
  itemName: string;
  resultText: string;
  numericValue: number;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  referenceStatus: "trusted" | "raw_only" | "missing";
  referenceReason: string | null;
  abnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  reportedAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  abnormalSource: "stored" | "result_marker" | "marker_column" | "evidence_marker" | "qualitative_result" | "reference_range" | "none";
  abnormalStatus: "reported" | "computed" | "conflict" | "unresolved";
  abnormalConflict: boolean;
  abnormalReason: string | null;
  evidenceQuote: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationConfidence: number | null;
  normalizationReason: string | null;
  trendOutlier: boolean;
  trendOutlierReason: string | null;
  sourceLineIds: string[];
  resultLineIds: string[];
  sourcePage: {
    id: string;
    pageNumber: number;
    originalName: string;
    mimeType: string;
    sourcePageNumber: number | null;
  } | null;
};

export type TrendSeries = {
  indicatorKey: string;
  name: string;
  unit: string | null;
  pinned: boolean;
  groupKey: string;
  groupName: string;
  groupOrder: number;
  subgroupKey: string | null;
  subgroupName: string | null;
  subgroupOrder: number;
  itemOrder: number;
  sectionName: string | null;
  quality: "high" | "medium" | "low" | "excluded" | "raw";
  confidence: number | null;
  explanation: string | null;
  searchAliases: string[];
  attentionLevel: "abnormal" | "near_boundary" | null;
  attentionReason: string | null;
  attentionBoundary: "upper" | "lower" | null;
  attentionConflict: boolean;
  abnormalContinuityStatus: "none" | "latest_abnormal" | "persistent_abnormal" | "recovered" | "near_boundary" | "conflict" | "insufficient_evidence";
  abnormalContinuityReason: string | null;
  latestAbnormal: boolean;
  latestAbnormalDirection: "high" | "low" | "abnormal" | "normal" | "unknown";
  consecutiveAbnormalCount: number;
  totalAbnormalCount: number;
  previousAbnormalCount: number;
  recoveredFromAbnormal: boolean;
  abnormalConflictPointCount: number;
  attentionPriority: "normal" | "notice" | "attention";
  comparable: boolean;
  comparabilityStatus: "comparable" | "range_drift" | "condition_mismatch" | "insufficient_evidence";
  comparabilityReason: string | null;
  referenceProfileKey: string | null;
  referenceProfileCount: number;
  latestPairComparabilityStatus: "comparable" | "range_drift" | "condition_mismatch" | "insufficient_evidence";
  changeAssessmentAllowed: boolean;
  latestChangeStatus: "baseline" | "unchanged" | "increase" | "decrease" | "not_comparable" | "needs_review";
  latestChangeMagnitude: "unavailable" | "unchanged" | "small" | "moderate" | "large";
  latestChangeReason: string | null;
  latestChangeConclusionAllowed: boolean;
  latestIntervalDays: number | null;
  latestIntervalBucket: "unknown" | "same_day" | "short_term" | "medium_term" | "long_term";
  trendStatus: "baseline" | "stable" | "sustained_rise" | "sustained_fall" | "fluctuating" | "insufficient_evidence";
  trendReason: string;
  trendConclusionAllowed: boolean;
  trendDurationDays: number | null;
  trendIntervalRegularity: "unknown" | "regular" | "irregular";
  analysisPointCount: number;
  outlierCount: number;
  typicalMinValue: number | null;
  typicalMaxValue: number | null;
  matchReasons: string[];
  sourceNames: string[];
  excludedPoints: TrendExcludedPoint[];
  pointCount: number;
  firstDate: string | null;
  lastDate: string | null;
  latestValue: number | null;
  previousValue: number | null;
  delta: number | null;
  minValue: number | null;
  maxValue: number | null;
  points: TrendPoint[];
};

export type IndicatorNormalizationSourceOrigin =
  | "item_name"
  | "item_code"
  | "combined"
  | "ai_normalized_name"
  | "none"
  | "manual_confirmation"
  | "manual_exclusion"
  | "legacy";

export type IndicatorNormalizationIssue = {
  fingerprint: string;
  representativeObservationId: string;
  rawName: string;
  normalizedName: string | null;
  resultText: string;
  unit: string | null;
  sectionName: string | null;
  hospitalName: string | null;
  status: "unknown" | "low" | "excluded";
  reason: string;
  count: number;
  latestReportIssuedAt: string | null;
  candidateCanonicalKey: string | null;
  candidateCanonicalName: string | null;
  candidateDefaultUnit: string | null;
  candidateQuality: "low" | "excluded" | null;
  matchedBy: string | null;
  sourceOrigin: IndicatorNormalizationSourceOrigin;
};

export type IndicatorCatalogOption = {
  canonicalKey: string;
  displayName: string;
  category: string;
  defaultUnit: string | null;
  aliases: string[];
};

export type IndicatorNormalizationMetrics = {
  version: string;
  generatedAt: string;
  totals: {
    reports: number;
    observations: number;
    normalizationRows: number;
    mapped: number;
    trendEligible: number;
    needsReview: number;
    reviewed: number;
    issueGroups: number;
    decisions: number;
    userAliases: number;
  };
  quality: Record<"high" | "medium" | "low" | "excluded", number>;
  sourceOrigins: Array<{
    sourceOrigin: IndicatorNormalizationSourceOrigin;
    count: number;
    trendEligible: number;
  }>;
  reportTypes: Array<{
    reportType: string;
    reports: number;
    observations: number;
    mapped: number;
    trendEligible: number;
    needsReview: number;
  }>;
};

export type IndicatorGovernanceResult = {
  fingerprint: string;
  action: "confirm" | "exclude";
  affectedObservations: number;
  normalized: number;
  excluded: number;
  aliasSaved: boolean;
  canonicalKey: string | null;
};

export type IndicatorGovernanceHistoryItem = {
  id: string;
  eventType: "apply" | "undo" | "alias_enable" | "alias_disable";
  fingerprint: string | null;
  decisionAction: "confirm" | "exclude" | null;
  rawName: string | null;
  canonicalKey: string | null;
  canonicalName: string | null;
  aliasId: string | null;
  aliasName: string | null;
  aliasScope: "global" | "hospital" | "department" | "report_type" | null;
  reportType: string | null;
  reason: string | null;
  affectedObservations: number;
  actorName: string | null;
  createdAt: string;
  canUndo: boolean;
};

export type IndicatorGovernanceUndoResult = {
  fingerprint: string;
  action: "confirm" | "exclude";
  affectedObservations: number;
  aliasDisabled: boolean;
  remainingMapped: number;
  reopenedIssues: number;
};

export type IndicatorAliasGovernanceItem = {
  id: string;
  aliasName: string;
  normalizedAlias: string;
  scope: "global" | "hospital" | "department" | "report_type";
  hospitalName: string | null;
  departmentName: string | null;
  reportType: string | null;
  canonicalKey: string;
  canonicalName: string;
  category: string;
  enabled: boolean;
  usageCount: number;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

export type IndicatorAliasConflict = {
  normalizedAlias: string;
  scope: "global" | "hospital" | "department" | "report_type";
  hospitalName: string | null;
  departmentName: string | null;
  reportType: string | null;
  targets: Array<{
    aliasId: string;
    aliasName: string;
    canonicalKey: string;
    canonicalName: string;
    source: "builtin" | "user" | "ai_suggestion";
  }>;
};

export type IndicatorAliasGovernanceOverview = {
  aliases: IndicatorAliasGovernanceItem[];
  conflicts: IndicatorAliasConflict[];
};

export type IndicatorAliasUpdateResult = {
  aliasId: string;
  enabled: boolean;
  affectedObservations: number;
  normalized: number;
  reopenedIssues: number;
};

export type ClinicalEvidence = Array<{ pageNumber: number; quote: string }>;
export type ClinicalFactSource = "ai" | "manual" | "legacy_migration";
export type ClinicalFactType =
  | "diagnosis"
  | "medication"
  | "procedure"
  | "vaccination"
  | "billingSummary"
  | "billingItem";

export type ReportDiagnosis = {
  id: string;
  reportId: string;
  sectionName: string | null;
  diagnosisType: "outpatient" | "admission" | "discharge" | "pathology" | "other";
  diagnosisText: string;
  diagnosisCode: string | null;
  codeSystem: string | null;
  isPrimary: boolean;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportMedication = {
  id: string;
  reportId: string;
  sectionName: string | null;
  context: "prescription" | "outpatient" | "inpatient" | "discharge" | "other";
  medicationName: string;
  genericName: string | null;
  specification: string | null;
  dosageForm: string | null;
  dose: string | null;
  doseUnit: string | null;
  frequency: string | null;
  route: string | null;
  duration: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  instructions: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportProcedure = {
  id: string;
  reportId: string;
  sectionName: string | null;
  procedureType: "examination" | "treatment" | "surgery" | "other";
  procedureName: string;
  procedureCode: string | null;
  bodyPart: string | null;
  performedAt: string | null;
  resultText: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type VaccinationRecord = {
  id: string;
  reportId: string;
  vaccineName: string;
  doseNumber: string | null;
  manufacturer: string | null;
  lotNumber: string | null;
  administeredAt: string | null;
  administrationSite: string | null;
  nextDueAt: string | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type BillingSummary = {
  id: string;
  reportId: string;
  invoiceNumber: string | null;
  totalAmount: number | null;
  insuranceAmount: number | null;
  selfPayAmount: number | null;
  currency: string;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type BillingItem = {
  id: string;
  reportId: string;
  category: string | null;
  itemName: string;
  amount: number | null;
  quantity: number | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export const reportStructuredSectionKeys = [
  "checkup_package",
  "checkup_positive_findings",
  "checkup_abnormal_summary",
  "checkup_final_conclusion",
  "checkup_original_recommendation",
  "laboratory_specimen",
  "laboratory_method",
  "imaging_modality",
  "imaging_contrast",
  "functional_method",
  "functional_description",
  "pathology_specimen",
  "pathology_gross_findings",
  "pathology_microscopic_findings",
  "pathology_immunohistochemistry",
  "pathology_grade",
  "pathology_stage",
  "outpatient_history",
  "outpatient_physical_examination",
  "outpatient_disposition",
  "outpatient_advice",
  "inpatient_course",
  "inpatient_discharge_instructions"
] as const;

export type ReportStructuredSectionKey = typeof reportStructuredSectionKeys[number];

export type ReportStructuredSection = {
  id: string;
  reportId: string;
  sectionKey: ReportStructuredSectionKey;
  title: string;
  content: string;
  contentData: Record<string, unknown> | null;
  evidence: ClinicalEvidence;
  source: ClinicalFactSource;
  manualFields: string[];
};

export type ReportDetail = ReportSummary & {
  createdAt: string;
  updatedAt: string;
  city: string | null;
  visitType: string | null;
  visitDepartment: string | null;
  orderingDepartment: string | null;
  performingDepartment: string | null;
  reportingDepartment: string | null;
  inpatientWard: string | null;
  bodyParts: Array<{ raw: string; name: string; parent: string | null; laterality: string }>;
  identifiers: Record<string, string>;
  examinedAt: string | null;
  orderedAt: string | null;
  sampledAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  clinicians: Record<string, string>;
  clinicalDiagnosis: string | null;
  purpose: string | null;
  chiefComplaint: string | null;
  summary: string | null;
  findings: string | null;
  impression: string | null;
  recommendation: string | null;
  pages: ReportPage[];
  observations: Observation[];
  morphologyFindings: MorphologyFinding[];
  diagnoses: ReportDiagnosis[];
  medications: ReportMedication[];
  procedures: ReportProcedure[];
  vaccinations: VaccinationRecord[];
  billingSummary: BillingSummary | null;
  billingItems: BillingItem[];
  structuredSections: ReportStructuredSection[];
  duplicateCandidates: DuplicateReportCandidate[];
  manualFieldKeys: string[];
};

export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

export type Reminder = {
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
};

export type AppNotification = {
  id: string;
  memberId: string;
  reportId: string | null;
  type: "report_processed" | "report_failed";
  title: string;
  message: string | null;
  severity: "info" | "success" | "warning" | "error";
  status: "unread" | "read" | "archived";
  createdAt: string;
  readAt: string | null;
  reportTitle: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type UserOperationAuditLog = {
  id: string;
  action: string;
  title: string;
  description: string;
  targetLabel: string;
  targetId: string | null;
  targetName: string | null;
  actorName: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
};

export type AiAuditSummary = {
  summary: {
    jobCount: number;
    callCount: number;
    successJobs: number;
    failedJobs: number;
    queuedJobs: number;
    processingJobs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgElapsedMs: number;
  };
  recent: Array<{
    id: string;
    source: "report_extraction" | "indicator_normalization" | string;
    reportId: string | null;
    reportTitle: string;
    memberId: string | null;
    status: string;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    provider: string | null;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    elapsedMs: number | null;
    inputCharacters: number | null;
    documentContentType: string | null;
    routedContentTypes: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
};

export type SystemLogItem = {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  category: string;
  title: string;
  detail: string;
  metadata: string[];
};

export type SystemLogPage = {
  items: SystemLogItem[];
  nextCursor: string | null;
  hasMore: boolean;
  filter: "important" | "all";
  stats: {
    totalBytes: number;
    currentFileBytes: number;
    fileCount: number;
    archiveCount: number;
    maxFileBytes: number;
    maxArchiveFiles: number;
    maxTotalBytes: number;
  };
};
